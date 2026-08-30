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
const { isDebugEnabled, describeError, redactSensitiveText } = await import(DIST + "logger.js");
const { handleSdkMessage, QoderLanguageModel } = await import(DIST + "language-model.js");
const { ensureQoderSession, getQoderSession, getQoderSessionForCwd, deleteQoderSession } = await import(DIST + "session-store.js");
const { buildPromptString, buildPromptIterable } = await import(DIST + "prompt-builder.js");
const { selectEnabledModels, applyLiveModelUpdates, getModel, listModels } = await import(DIST + "models.js");

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

  test("redacts credentials from diagnostic text", () => {
    const old = process.env.QODER_PERSONAL_ACCESS_TOKEN;
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-secret-value-123";
    try {
      const text = describeError(new Error("Authorization: Bearer pt-secret-value-123 token=pt-secret-value-123"));
      assert.equal(text.includes("pt-secret-value-123"), false);
      assert.equal(redactSensitiveText("https://example.test/?access_token=hidden"), "https://example.test/?access_token=[REDACTED]");
      assert.equal(redactSensitiveText(JSON.stringify({ token: "pt-secret-value-123" })).includes("pt-secret-value-123"), false);
    } finally {
      if (old === undefined) delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
      else process.env.QODER_PERSONAL_ACCESS_TOKEN = old;
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
      openBlocks: [],
      sawStreamText: false,
      sawStreamTool: false,
      sawStreamReasoning: false,
      emittedToolCall: false,
      pendingToolCalls: new Map(),
      lastStopReason: null,
      blockCounter: 0,
      outputChars: 0,
      finished: false,
      resultReceived: false,
      artifacts: [],
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

  test("captures plan_mode_changed event into providerMetadata", () => {
    const { parts, state } = makeState();
    handleSdkMessage(
      {
        type: "system",
        subtype: "plan_mode_changed",
        plan_mode: { active: true, source: "user" },
      },
      state,
    );
    handleSdkMessage({ type: "result", subtype: "success", usage: {} }, state);
    const finish = parts.find((p) => p.type === "finish");
    assert.deepEqual(finish.providerMetadata?.qoder?.planMode, { active: true, source: "user" });
  });

  test("captures artifacts_update events into providerMetadata", () => {
    const { parts, state } = makeState();
    handleSdkMessage(
      {
        type: "system",
        subtype: "artifacts_update",
        artifacts: [
          {
            path: "/path/to/file.ts",
            display_path: "file.ts",
            name: "file.ts",
            kind: "changed",
            additions: 10,
            deletions: 2,
            is_new: false,
          },
        ],
      },
      state,
    );
    handleSdkMessage({ type: "result", subtype: "success", usage: {} }, state);
    const finish = parts.find((p) => p.type === "finish");
    assert.ok(Array.isArray(finish.providerMetadata?.qoder?.artifacts));
    assert.equal(finish.providerMetadata.qoder.artifacts.length, 1);
    assert.equal(finish.providerMetadata.qoder.artifacts[0].name, "file.ts");
  });

  test("captures skill_evolution events into providerMetadata", () => {
    const { parts, state } = makeState();
    handleSdkMessage(
      {
        type: "system",
        subtype: "skill_evolution",
        result: { status: "suggested", suggestions: [{ skillName: "test-skill", action: "create" }] },
      },
      state,
    );
    handleSdkMessage({ type: "result", subtype: "success", usage: {} }, state);
    const finish = parts.find((p) => p.type === "finish");
    assert.equal(finish.providerMetadata?.qoder?.skillEvolution?.status, "suggested");
  });

  test("SDK failure results emit typed error part", () => {
    const { parts, state } = makeState();
    handleSdkMessage({ type: "result", subtype: "error_during_execution", errors: ["boom", "Authorization: Bearer qoder-secret-value"] }, state);

    const errorPart = parts.find((p) => p.type === "error");
    assert.ok(errorPart?.error instanceof QoderBridgeError);
    assert.equal(errorPart.error.code, "QODER_SDK_RESULT_ERROR");
    assert.equal(errorPart.error.subtype, "error_during_execution");
    assert.equal(errorPart.error.message.includes("qoder-secret-value"), false);
    const finish = parts.find((p) => p.type === "finish");
    assert.equal(finish.finishReason.unified, "error");
  });

  test("duplicate tool events produce one OpenCode tool call", () => {
    const { parts, state } = makeState({ functionToolNames: new Set(["read"]) });
    const start = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "tool-1", name: "Read" },
      },
    };
    handleSdkMessage(start, state);
    handleSdkMessage(start, state);
    handleSdkMessage({
      type: "stream_event",
      event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"x"}' } },
    }, state);
    handleSdkMessage({ type: "stream_event", event: { type: "content_block_stop", index: 2 } }, state);
    handleSdkMessage({ type: "stream_event", event: { type: "content_block_stop", index: 2 } }, state);
    handleSdkMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "x" } }] },
    }, state);

    assert.equal(parts.filter((part) => part.type === "tool-call").length, 1);
    assert.equal(parts.filter((part) => part.type === "tool-input-start").length, 1);
  });

  test("MCP tool names remain provider-owned despite normalized host collisions", () => {
    const { parts, state } = makeState({ functionToolNames: new Set(["demo_run"]) });
    handleSdkMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 4, content_block: { type: "tool_use", id: "mcp-call", name: "mcp__demo__run" } },
    }, state);
    handleSdkMessage({
      type: "stream_event",
      event: { type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: "{}" } },
    }, state);
    handleSdkMessage({ type: "stream_event", event: { type: "content_block_stop", index: 4 } }, state);
    assert.equal(parts.filter((part) => part.type === "tool-call").length, 0);
  });

  test("malformed SDK usage cannot emit non-finite provider usage", () => {
    const { parts, state } = makeState();
    handleSdkMessage({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: "bad",
        output_tokens: -10,
        cache_read_input_tokens: Infinity,
        context_usage_ratio: 4,
      },
      total_cost_usd: NaN,
      modelUsage: { auto: { inputTokens: NaN } },
    }, state);

    const finish = parts.find((part) => part.type === "finish");
    assert.ok(finish);
    assert.equal(finish.usage.inputTokens.total, 200_000);
    assert.equal(finish.usage.outputTokens.total, 0);
    assert.ok(Number.isFinite(finish.usage.inputTokens.total));
    assert.equal(finish.providerMetadata.qoder.totalCostUSD, 0);
    assert.equal(parts.filter((part) => part.type === "finish").length, 1);

    // A late duplicate result must be ignored after the terminal part.
    handleSdkMessage({ type: "result", subtype: "success", usage: { input_tokens: 1 } }, state);
    assert.equal(parts.filter((part) => part.type === "finish").length, 1);
  });

  test("truncated tool streams close input without executing an incomplete call", () => {
    const { parts, state } = makeState({ functionToolNames: new Set(["read"]) });
    handleSdkMessage({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 3,
        content_block: { type: "tool_use", id: "partial-tool", name: "Read" },
      },
    }, state);
    handleSdkMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 3,
        delta: { type: "input_json_delta", partial_json: '{"path":"x"}' },
      },
    }, state);
    handleSdkMessage({ type: "result", subtype: "success", usage: {} }, state);

    assert.equal(parts.filter((part) => part.type === "tool-input-start").length, 1);
    assert.equal(parts.filter((part) => part.type === "tool-input-end").length, 1);
    assert.equal(parts.filter((part) => part.type === "tool-call").length, 0);
    assert.equal(parts.find((part) => part.type === "error")?.error?.subtype, "incomplete_stream");
    assert.equal(parts.at(-1).type, "finish");
    assert.equal(parts.at(-1).finishReason.unified, "error");
  });

  test("replayed SDK messages with the same UUID emit one logical delta", () => {
    const { parts, state } = makeState();
    const delta = {
      type: "stream_event",
      uuid: "message-1",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "A" } },
    };
    handleSdkMessage(delta, state);
    handleSdkMessage(delta, state);
    assert.equal(parts.filter((part) => part.type === "text-delta").length, 1);
    assert.equal(parts.filter((part) => part.type === "text-start").length, 1);
  });

  test("malformed indexes and tool JSON fail safely", () => {
    const first = makeState();
    handleSdkMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: "bad", content_block: { type: "text" } },
    }, first.state);
    assert.equal(first.parts.find((part) => part.type === "error")?.error?.subtype, "malformed_stream");
    assert.equal(first.parts.at(-1).finishReason.unified, "error");

    const second = makeState({ functionToolNames: new Set(["read"]) });
    handleSdkMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "bad-json", name: "Read" } },
    }, second.state);
    handleSdkMessage({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    }, second.state);
    handleSdkMessage({ type: "stream_event", event: { type: "content_block_stop", index: 1 } }, second.state);
    assert.equal(second.parts.find((part) => part.type === "error")?.error?.subtype, "invalid_tool_input");
    assert.equal(second.parts.filter((part) => part.type === "tool-call").length, 0);
  });

  test("result stop reason maps when no message_delta was emitted", () => {
    const { parts, state } = makeState();
    handleSdkMessage({ type: "result", subtype: "success", stop_reason: "max_tokens", usage: {} }, state);
    assert.equal(parts.at(-1).finishReason.unified, "length");
  });

  test("sanitizes raw stop reasons exposed in finish metadata", () => {
    const { parts, state } = makeState();
    handleSdkMessage({ type: "result", subtype: "success", stop_reason: "Bearer pt-stop-secret", usage: {} }, state);
    const raw = parts.at(-1)?.finishReason.raw ?? "";
    assert.equal(raw.includes("pt-stop-secret"), false);
    assert.equal(/\u001b/.test(raw), false);
  });

  test("malformed stream boundaries fail closed", () => {
    const cases = [
      { type: "stream_event", event: { type: "content_block_start", index: 1 } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1 } },
      { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
      { type: "assistant", message: {} },
    ];
    for (const message of cases) {
      const { parts, state } = makeState();
      handleSdkMessage(message, state);
      assert.equal(parts.find((part) => part.type === "error")?.error?.subtype, "malformed_stream");
      assert.equal(parts.at(-1)?.type, "finish");
      assert.equal(parts.at(-1)?.finishReason.unified, "error");
    }

    const missingInput = makeState({ functionToolNames: new Set(["read"]) });
    handleSdkMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "missing-input", name: "Read" } },
    }, missingInput.state);
    handleSdkMessage({ type: "stream_event", event: { type: "content_block_stop", index: 3 } }, missingInput.state);
    assert.equal(missingInput.parts.find((part) => part.type === "error")?.error?.subtype, "malformed_tool_input");
    assert.equal(missingInput.parts.filter((part) => part.type === "tool-call").length, 0);
  });

  test("closes open blocks in stream start order before the terminal error", () => {
    const { parts, state } = makeState({ functionToolNames: new Set(["read"]) });
    handleSdkMessage({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text" } } }, state);
    handleSdkMessage({ type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "ordered-tool", name: "Read" } } }, state);
    handleSdkMessage({ type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } } }, state);
    handleSdkMessage({ type: "stream_event", event: { type: "content_block_start", index: 3, content_block: { type: "thinking" } } }, state);
    handleSdkMessage({ type: "result", subtype: "success", usage: {} }, state);
    const ends = parts.filter((part) => part.type === "text-end" || part.type === "tool-input-end" || part.type === "reasoning-end");
    assert.deepEqual(ends.map((part) => part.id), ["1", "ordered-tool", "3"]);
    assert.equal(parts.at(-1)?.finishReason.unified, "error");
  });
});

describe("session and usage isolation", () => {
  test("session keys are prototype-safe and workspace-scoped", async () => {
    const saved = await ensureQoderSession("toString", "session-a", "/tmp/project-a");
    assert.equal(saved.qoderSessionId, "session-a");
    assert.equal((await getQoderSession("toString")).qoderSessionId, "session-a");
    assert.equal(await getQoderSessionForCwd("toString", "/tmp/project-b"), null);

    const replaced = await ensureQoderSession("toString", "session-b", "/tmp/project-b");
    assert.equal(replaced.qoderSessionId, "session-b");
    assert.equal((await getQoderSessionForCwd("toString", "/tmp/project-a")).qoderSessionId, "session-a");
    assert.equal((await getQoderSessionForCwd("toString", "/tmp/project-b")).qoderSessionId, "session-b");
    await deleteQoderSession("toString");
  });

  test("refuses to overwrite a corrupt session file", async () => {
    const stateFile = join(STATE_ROOT, "sessions.json");
    let previous;
    try { previous = readFileSync(stateFile); } catch { /* file may not exist */ }
    const corrupt = Buffer.from('{"keep":{"qoderSessionId":"sid"');
    writeFileSync(stateFile, corrupt);
    try {
      await assert.rejects(() => ensureQoderSession("new", "sid-new", "/tmp/project"), /refusing to overwrite/);
      assert.deepEqual(readFileSync(stateFile), corrupt);
    } finally {
      if (previous) writeFileSync(stateFile, previous);
      else rmSync(stateFile, { force: true });
    }
  });

  test("refuses to rewrite a session file with one invalid entry", async () => {
    const stateFile = join(STATE_ROOT, "sessions.json");
    let previous;
    try { previous = readFileSync(stateFile); } catch { /* file may not exist */ }
    const mixed = Buffer.from(JSON.stringify({
      keep: { qoderSessionId: "sid", cwd: "/tmp/keep", createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() },
      broken: { qoderSessionId: 42 },
    }));
    writeFileSync(stateFile, mixed);
    try {
      assert.equal((await getQoderSessionForCwd("keep", "/tmp/keep")).qoderSessionId, "sid");
      await assert.rejects(() => ensureQoderSession("new", "sid-new", "/tmp/project"), /refusing to overwrite/);
      assert.deepEqual(readFileSync(stateFile), mixed);
    } finally {
      if (previous) writeFileSync(stateFile, previous);
      else rmSync(stateFile, { force: true });
    }
  });

  test("usage fetch clears its inflight promise when no credential exists", async () => {
    const script = `
      delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
      const { getLiveUsage } = await import(${JSON.stringify(new URL("../dist/usage.js", import.meta.url).href)});
      const first = getLiveUsage(true);
      await first;
      const second = getLiveUsage(true);
      if (first === second) process.exit(2);
      await second;
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, HOME: join(STATE_ROOT, "no-qoder-home"), QODER_BRIDGE_STATE_DIR: join(STATE_ROOT, "usage-child") },
    });
  });
});

describe("TUI registration concurrency", () => {
  test("concurrent registration keeps one plugin entry", async () => {
    const { ensureTuiRegistered } = await import(DIST + "tui-register.js");
    const configPath = join(STATE_ROOT, "opencode", "tui.json");
    const entry = "file:///tmp/qoder-bridge-test-tui.js";
    await Promise.all(Array.from({ length: 8 }, () => ensureTuiRegistered(configPath, entry)));
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.plugin, [entry]);
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

  test("cancels the stream reader when generation receives an error part", async () => {
    const { QoderLanguageModel } = await import(DIST + "language-model.js");
    const lm = new QoderLanguageModel("auto");
    let canceled = false;
    lm.doStream = async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "error", error: new Error("Authorization: Bearer pt-reader-secret") });
        },
        cancel() {
          canceled = true;
        },
      }),
    });
    await assert.rejects(() => lm.doGenerate({ prompt: [] }), (error) => {
      assert.equal(error.message.includes("pt-reader-secret"), false);
      return true;
    });
    assert.equal(canceled, true);
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

  test("trims assistant tool calls together with their results", () => {
    const result = buildPromptString([
      { role: "system", content: "system" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "old-call", toolName: "read", input: { path: "old.ts" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "old-call", toolName: "read", output: "old result" }] },
      { role: "user", content: "current question" },
    ], 120);
    assert.equal(result.includes("old result"), result.includes("old-call"), "tool call and result must be retained or dropped together");
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

describe("model catalog selection", () => {
  const entry = (value, extra = {}) => ({ value, displayName: value, description: "", ...extra });

  test("keeps enabled, BYOK, and tagged entries; drops disabled and malformed", () => {
    const kept = selectEnabledModels([
      entry("auto"),
      entry("byok-gpt", { source: "user", provider: "openai" }),
      entry("promo", { tags: ["limited_time_free"] }),
    ]);
    assert.deepEqual(kept.map((m) => m.value), ["auto", "byok-gpt", "promo"]);

    const filtered = selectEnabledModels([
      entry("gone", { isEnabled: false }),
      null,
      undefined,
      { displayName: "no id" },
      entry("", {}),
    ]);
    assert.deepEqual(filtered, []);
  });

  test("discovery uses the live fetch strategy with cache fallback in the SDK", async () => {
    const src = await import("node:fs").then((fs) => fs.promises.readFile(DIST + "models.js", "utf8"));
    assert.match(src, /fetchStrategy:\s*"live"/, "must request live catalog");
    assert.doesNotMatch(src, /fetchStrategy:\s*"cache"/, "must not serve stale cache as first choice");
  });

  test("live catalog snapshots remove models that are no longer available", () => {
    applyLiveModelUpdates([
      entry("audit-model-old", { displayName: "Old model" }),
      entry("audit-model-current", { displayName: "Current model" }),
    ]);
    assert.ok(getModel("audit-model-old"));

    applyLiveModelUpdates([entry("audit-model-current", { displayName: "Current model" })]);
    assert.equal(getModel("audit-model-old"), undefined);
    assert.equal(listModels().some((model) => model.id === "audit-model-old"), false);
  });
});

test.after?.(() => {
  rmSync(STATE_ROOT, { recursive: true, force: true });
});
