import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;

const STATE_ROOT = mkdtempSync(join(tmpdir(), "qoder-bridge-hardening-"));
process.env.QODER_BRIDGE_STATE_DIR = STATE_ROOT;

const { QoderBridgeError, QoderCliNotFoundError, QoderSessionError, QoderSdkResultError, UnsupportedCapabilityError } =
  await import(DIST + "errors.js");
const { resolveStateDir } = await import(DIST + "state-dir.js");
const { isDebugEnabled } = await import(DIST + "logger.js");
const { handleSdkMessage, QoderLanguageModel } = await import(DIST + "language-model.js");
const { ensureQoderSession } = await import(DIST + "session-store.js");
const { buildPromptString } = await import(DIST + "prompt-builder.js");

describe("typed errors", () => {
  test("subclasses expose stable codes and names", () => {
    const cases = [
      [new QoderCliNotFoundError(), "QODER_CLI_NOT_FOUND", "QoderCliNotFoundError"],
      [new QoderSessionError("bad key"), "QODER_SESSION_INVALID_KEY", "QoderSessionError"],
      [new QoderSdkResultError("error_during_execution"), "QODER_SDK_RESULT_ERROR", "QoderSdkResultError"],
      [new UnsupportedCapabilityError("image generation"), "QODER_UNSUPPORTED_CAPABILITY", "UnsupportedCapabilityError"],
    ];
    for (const [error, code, name] of cases) {
      assert.ok(error instanceof Error);
      assert.ok(error instanceof QoderBridgeError, `${name} must extend QoderBridgeError`);
      assert.equal(error.code, code);
      assert.equal(error.name, name);
    }
    assert.equal(new QoderSdkResultError("overloaded", "[rate limited]").message, "Qoder SDK: overloaded | [rate limited]");
  });

  test("cause option is preserved", () => {
    const cause = new Error("root");
    const error = new QoderCliNotFoundError("wrapped", { cause });
    assert.equal(error.cause, cause);
  });

  test("ensureQoderSession throws typed error for unsafe keys", async () => {
    await assert.rejects(
      () => ensureQoderSession("__proto__", "sid", "/tmp"),
      (error) => error instanceof QoderBridgeError && error.code === "QODER_SESSION_INVALID_KEY",
    );
  });
});

describe("state dir resolution", () => {
  test("override beats XDG beats default", () => {
    const overridden = resolveStateDir({ QODER_BRIDGE_STATE_DIR: "/custom/state", XDG_CONFIG_HOME: "/xdg" });
    assert.equal(overridden, join("/custom", "state"));
    assert.equal(resolveStateDir({ XDG_CONFIG_HOME: "/xdg" }), join("/xdg", "opencode-qoder-bridge"));
    const fallback = resolveStateDir({});
    assert.ok(fallback.endsWith(join(".config", "opencode-qoder-bridge")));
  });

  test("whitespace-only values are ignored", () => {
    assert.equal(
      resolveStateDir({ QODER_BRIDGE_STATE_DIR: "   ", XDG_CONFIG_HOME: "/xdg" }),
      join("/xdg", "opencode-qoder-bridge"),
    );
  });
});

describe("debug logging gate", () => {
  test("disabled without QODER_BRIDGE_DEBUG", () => {
    const old = process.env.QODER_BRIDGE_DEBUG;
    delete process.env.QODER_BRIDGE_DEBUG;
    try {
      assert.equal(isDebugEnabled(), false);
      process.env.QODER_BRIDGE_DEBUG = "1";
      assert.equal(isDebugEnabled(), true);
    } finally {
      if (old === undefined) delete process.env.QODER_BRIDGE_DEBUG;
      else process.env.QODER_BRIDGE_DEBUG = old;
    }
  });
});

function makeState(overrides = {}) {
  const parts = [];
  return {
    parts,
    state: {
      controller: { enqueue: (part) => parts.push(part), close: () => {} },
      contextWindow: 200_000,
      functionToolNames: new Set(),
      activeText: new Set(),
      activeReasoning: new Set(),
      toolBlocks: new Map(),
      sawStreamText: false,
      sawStreamTool: false,
      sawStreamReasoning: false,
      emittedToolCall: false,
      pendingToolCalls: new Map(),
      lastStopReason: null,
      blockCounter: 0,
      finished: false,
      ...overrides,
    },
  };
}

describe("result metadata shape", () => {
  test("providerMetadata nests qoder fields exactly once", () => {
    const { parts, state } = makeState();
    handleSdkMessage(
      {
        type: "result",
        subtype: "success",
        usage: { context_usage_ratio: 0.5 },
        total_cost_usd: 0.42,
        modelUsage: { lite: { inputTokens: 1 } },
      },
      state,
    );

    const finish = parts.find((p) => p.type === "finish");
    assert.ok(finish, "must emit finish");
    const meta = finish.providerMetadata?.qoder;
    assert.ok(meta, "must carry providerMetadata.qoder");
    assert.equal(meta.totalCostUSD, 0.42);
    assert.equal(meta.contextUsageRatio, 0.5);
    assert.equal(meta.qoder, undefined, "must not double-nest a second qoder object");
  });

  test("SDK failure results emit typed error part", () => {
    const { parts, state } = makeState();
    handleSdkMessage({ type: "result", subtype: "error_during_execution", errors: ["boom"] }, state);

    const errorPart = parts.find((p) => p.type === "error");
    assert.ok(errorPart?.error instanceof QoderBridgeError);
    assert.equal(errorPart.error.code, "QODER_SDK_RESULT_ERROR");
    assert.equal(errorPart.error.subtype, "error_during_execution");
    const finish = parts.find((p) => p.type === "finish");
    assert.equal(finish.finishReason.unified, "error");
  });
});

describe("doGenerate content aggregation", () => {
  test("tool calls survive the generate path alongside text", async () => {
    const lm = new QoderLanguageModel("auto");
    lm.doStream = async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-delta", id: "1", delta: "running" });
          controller.enqueue({ type: "tool-input-start", id: "t1", toolName: "bash" });
          controller.enqueue({ type: "tool-call", toolCallId: "t1", toolName: "bash", input: '{"command":"ls"}' });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "tool-calls" },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 2 } },
          });
          controller.close();
        },
      }),
    });

    const result = await lm.doGenerate({ prompt: [] });
    const kinds = result.content.map((part) => part.type).join(",");
    assert.equal(kinds, "text,tool-call");
    assert.deepEqual(result.content[1], {
      type: "tool-call",
      toolCallId: "t1",
      toolName: "bash",
      input: '{"command":"ls"}',
    });
    assert.equal(result.finishReason.unified, "tool-calls");
  });
});

describe("history trimming", () => {
  const filler = "x".repeat(400);

  function bigPrompt(turns) {
    return [
      { role: "system", content: "you are helpful" },
      ...Array.from({ length: turns }, (_, i) =>
        i % 2 === 0
          ? { role: "user", content: `${filler} ${i}` }
          : { role: "assistant", content: [{ type: "text", text: `${filler} ${i}` }] },
      ),
      { role: "user", content: "final question" },
    ];
  }

  test("keeps system prompt and newest turn, marks dropped history once", () => {
    const result = buildPromptString(bigPrompt(6), 600);
    assert.match(result, /<truncated_history count="\d+" \/>/);
    assert.ok(result.includes("you are helpful"));
    assert.ok(result.includes("final question"));
    assert.ok(!result.includes(`${filler} 0`), "oldest turn must be dropped");
  });

  test("no truncation marker when history fits", () => {
    const result = buildPromptString(bigPrompt(2), 200_000);
    assert.ok(!result.includes("truncated_history"));
    assert.ok(result.includes(`${filler} 0`));
  });
});

describe("statusline binary", () => {
  test("reads ledger from resolved state dir", () => {
    const dir = join(STATE_ROOT, "statusline-fixture");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "usage.json"),
      JSON.stringify({ totalCostUsd: 1.23, turnCount: 4, totalInputTokens: 10, totalOutputTokens: 5 }),
    );
    const out = execFileSync(process.execPath, [join(DIST, "..", "bin", "statusline.mjs")], {
      encoding: "utf8",
      env: { ...process.env, QODER_BRIDGE_STATE_DIR: dir },
    });
    assert.ok(out.includes("cost $1.2300"));
    assert.ok(out.includes("turns 4"));
    assert.ok(out.includes("tok 15"));
  });

  test("degrades gracefully for missing ledger", () => {
    const out = execFileSync(process.execPath, [join(DIST, "..", "bin", "statusline.mjs")], {
      encoding: "utf8",
      env: { ...process.env, QODER_BRIDGE_STATE_DIR: join(STATE_ROOT, "does-not-exist") },
    });
    assert.match(out, /no usage yet/);
  });
});

describe("cost ledger crash safety", () => {
  test("exit flush persists turns that never reach the debounce timer", () => {
    const dir = join(STATE_ROOT, "exit-flush");
    rmSync(dir, { recursive: true, force: true });
    const script = `
      import(${JSON.stringify(new URL("../dist/cost.js", import.meta.url).href)})
        .then((m) => {
          m.recordTurn({
            model: "auto",
            usage: { input_tokens: 11, output_tokens: 7 },
            costUsd: 0.25,
            durationMs: 5,
            turns: 1,
          });
          process.exit(0);
        })
        .catch((error) => {
          console.error(error);
          process.exit(1);
        });
    `;
    execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, QODER_BRIDGE_STATE_DIR: dir },
    });

    const persisted = JSON.parse(readFileSync(join(dir, "usage.json"), "utf8"));
    assert.equal(persisted.turnCount, 1);
    assert.equal(persisted.totalCostUsd, 0.25);
    assert.equal(persisted.totalInputTokens, 11);
    assert.equal(persisted.recent.length, 1);
  });
});

test.after?.(() => {
  rmSync(STATE_ROOT, { recursive: true, force: true });
});
