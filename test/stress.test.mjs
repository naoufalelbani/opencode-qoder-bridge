import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

process.env.QODER_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), "qoder-stress-"));

const DIST = "../dist/";
const execFileAsync = promisify(execFile);

describe("prompt-builder stress & algorithmic correctness", () => {
  test("never drops the last user prompt even when conversation exceeds budget", async () => {
    const { buildPromptString } = await import(DIST + "prompt-builder.js");
    
    // Create a long conversation that greatly exceeds the budget
    const longPrompt = [
      { role: "system", content: "System instructions" },
      { role: "user", content: "User question from turn 1" },
      { role: "assistant", content: "A".repeat(100_000) },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "bash", output: "B".repeat(100_000) }] },
      { role: "user", content: "CRITICAL_LATEST_QUESTION" },
    ];

    // Context window is 20,000 tokens (80,000 chars), prompt is > 200,000 chars
    const result = buildPromptString(longPrompt, 20_000);
    assert.ok(result.includes("CRITICAL_LATEST_QUESTION"), "must preserve the latest user prompt");
    assert.notEqual(result, "Hello", "must not fall back to 'Hello' when user prompt exists");
  });

  test("does not drop the only user prompt during tool continuation turn when exceeding budget", async () => {
    const { buildPromptString } = await import(DIST + "prompt-builder.js");

    // Continuation turn: system + user + assistant + tool result
    const continuationPrompt = [
      { role: "system", content: "System instructions" },
      { role: "user", content: "Please analyze this large file and edit it" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { filePath: "big.ts" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: "X".repeat(200_000) }] },
    ];

    const result = buildPromptString(continuationPrompt, 10_000);
    assert.notEqual(result, "Hello", "must not fall back to 'Hello' during tool continuation");
    assert.ok(result.includes("Please analyze this large file"), "must retain the user's intent");
  });

  test("data URL parsing is fast and does not stall on large payloads", async () => {
    const { promptHasImage, buildPromptString } = await import(DIST + "prompt-builder.js");
    
    // 5MB dummy base64 string
    const largeB64 = "A".repeat(5 * 1024 * 1024);
    const dataUrl = `data:image/png;base64,${largeB64}`;

    const start = performance.now();
    const prompt = [
      {
        role: "user",
        content: [
          { type: "text", text: "check this image" },
          { type: "image", image: dataUrl },
        ],
      },
    ];

    promptHasImage(prompt);
    buildPromptString(prompt, 100_000);
    const duration = performance.now() - start;
    // Should complete in well under 500ms
    assert.ok(duration < 500, `Data URL processing took ${duration}ms, expected < 500ms`);
  });

  test("bounds aggregate current-turn image attachments", async () => {
    const { buildPromptIterable } = await import(DIST + "prompt-builder.js");
    const image = "data:image/png;base64,iVBORw0KGgo=";
    const chunks = [];
    for await (const chunk of buildPromptIterable(
      [{ role: "user", content: Array.from({ length: 100 }, () => ({ type: "image", image })) }],
      100_000,
      "image-limit",
    )) chunks.push(chunk);
    const content = chunks.flatMap((chunk) => chunk.message.content);
    assert.equal(content.filter((part) => part.type === "image").length, 64);
    assert.match(content.find((part) => part.type === "text")?.text ?? "", /omitted/);
  });
});

describe("stream abort & cancellation stress", () => {
  test("concurrent aborted streams do not throw unhandled rejection or error", async () => {
    const { QoderLanguageModel } = await import(DIST + "language-model.js");
    const lm = new QoderLanguageModel("auto");
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const ac = new AbortController();
        const { stream } = await lm.doStream({
          prompt: [{ role: "user", content: "hello" }],
          abortSignal: ac.signal,
        });
        const reader = stream.getReader();
        ac.abort();
        await reader.cancel().catch(() => {});
      })
    );
  });
});

describe("session store concurrent stress", () => {
  test("handles 50 concurrent ensureQoderSession calls without losing records", async () => {
    const { ensureQoderSession, getQoderSession } = await import(DIST + "session-store.js");
    
    const keys = Array.from({ length: 50 }, (_, i) => `concurrent-stress-${i}`);
    await Promise.all(
      keys.map((k) => ensureQoderSession(k, `session-${k}`, `/tmp/${k}`))
    );

    const results = await Promise.all(keys.map((k) => getQoderSession(k)));
    for (let i = 0; i < keys.length; i++) {
      assert.ok(results[i], `Record ${keys[i]} should exist`);
      assert.equal(results[i].qoderSessionId, `session-${keys[i]}`);
    }
  });

  test("serializes turns for one logical session", async () => {
    const { withQoderSessionLease } = await import(DIST + "session-store.js");
    const events = [];
    const turn = (label) => withQoderSessionLease("lease-stress", "/tmp/lease-stress", undefined, async () => {
      events.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`${label}:end`);
    });
    await Promise.all([turn("a"), turn("b")]);
    assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end"]);
  });
});

describe("doGenerate preserves providerMetadata", () => {
  test("doGenerate returns providerMetadata from finish part", async () => {
    const { QoderLanguageModel } = await import(DIST + "language-model.js");
    const lm = new QoderLanguageModel("auto");

    // Mock doStream to return finish part with providerMetadata
    lm.doStream = async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-delta", id: "0", delta: "hello" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop" },
            usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
            providerMetadata: {
              qoder: {
                totalCostUSD: 0.05,
                contextUsageRatio: 0.25,
                planMode: { active: true },
              },
            },
          });
          controller.close();
        },
      }),
    });

    const result = await lm.doGenerate({
      prompt: [{ role: "user", content: "hello" }],
    });

    assert.ok(result.providerMetadata?.qoder, "providerMetadata.qoder must be present in doGenerate result");
    assert.equal(result.providerMetadata.qoder.totalCostUSD, 0.05);
    assert.equal(result.providerMetadata.qoder.contextUsageRatio, 0.25);
  });
});

describe("cost ledger stress & edge cases", () => {
  test("handles 200 rapid turns with NaN / null / extreme values safely", async () => {
    const { recordTurn, summarize } = await import(DIST + "cost.js");

    for (let i = 0; i < 200; i++) {
      recordTurn({
        model: i % 2 === 0 ? "auto" : "__proto__",
        usage: {
          input_tokens: i % 3 === 0 ? null : (i % 5 === 0 ? NaN : i * 10),
          output_tokens: i % 4 === 0 ? undefined : (i % 7 === 0 ? Infinity : i * 5),
        },
        costUsd: i % 6 === 0 ? NaN : 0.001 * i,
        durationMs: i * 50,
        turns: 1,
      });
    }

    const s = summarize();
    assert.ok(Number.isFinite(s.totalCostUsd), "totalCostUsd must be finite");
    assert.ok(Number.isFinite(s.totalInputTokens), "totalInputTokens must be finite");
    assert.ok(Number.isFinite(s.totalOutputTokens), "totalOutputTokens must be finite");
    assert.equal(Object.hasOwn(s.byModel, "__proto__"), false);
  });
});

describe("cost ledger cross-process merge", () => {
  test("does not lose turns when two processes flush together", async () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), "qoder-cost-merge-"));
    const moduleUrl = new URL("../dist/cost.js", import.meta.url).href;
    const script = `
      const { recordTurn, flushLedgerSync } = await import(${JSON.stringify(moduleUrl)});
      recordTurn({ model: process.env.QODER_TEST_MODEL, costUsd: 1, durationMs: 1, turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
      flushLedgerSync();
    `;
    const env = { ...process.env, QODER_BRIDGE_STATE_DIR: ledgerDir };
    await Promise.all([
      execFileAsync(process.execPath, ["--input-type=module", "-e", script], { env }),
      execFileAsync(process.execPath, ["--input-type=module", "-e", script], { env }),
    ]);
    const ledger = JSON.parse(readFileSync(join(ledgerDir, "usage.json"), "utf8"));
    assert.equal(ledger.turnCount, 2);
    assert.equal(ledger.totalInputTokens, 2);
    assert.equal(ledger.totalOutputTokens, 2);
  });
});

describe("massive prompt scaling benchmark", () => {
  test("processes 1,000 conversation messages in under 200ms", async () => {
    const { buildPromptString } = await import(DIST + "prompt-builder.js");

    const messages = [];
    messages.push({ role: "system", content: "System preamble" });
    for (let i = 0; i < 500; i++) {
      messages.push({ role: "user", content: `User message turn ${i}` });
      messages.push({ role: "assistant", content: `Assistant reply turn ${i}` });
    }
    messages.push({ role: "user", content: "FINAL_PROMPT" });

    const start = performance.now();
    const result = buildPromptString(messages, 50_000);
    const duration = performance.now() - start;

    assert.ok(duration < 200, `Massive prompt processing took ${duration}ms, expected < 200ms`);
    assert.ok(result.includes("FINAL_PROMPT"), "must retain the final user prompt");
  });
});

describe("concurrent dynamic models updates and temp file safety", () => {
  test("concurrent applyLiveModelUpdates executes safely without leaking temp files", async () => {
    const { applyLiveModelUpdates, flushModelCache } = await import(DIST + "models.js");
    const { resolveStateDir } = await import(DIST + "state-dir.js");
    const { readdirSync } = await import("node:fs");

    const modelsList = Array.from({ length: 20 }, (_, i) => ({
      value: `model-stress-${i}`,
      displayName: `Model Stress ${i}`,
      priceFactor: 1.0 + i * 0.1,
      isEnabled: true,
    }));

    // Run 20 concurrent updates
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        return Promise.resolve().then(() => applyLiveModelUpdates(modelsList.slice(0, i + 1)));
      })
    );

    // Wait for the coalesced cache write to flush to disk
    await flushModelCache();

    // Check state directory for dangling .models.*.tmp files
    const stateDir = resolveStateDir();
    const files = readdirSync(stateDir);
    const danglingTmp = files.filter((f) => f.startsWith(".models.") && f.endsWith(".tmp"));
    assert.equal(danglingTmp.length, 0, `No dangling .models.*.tmp files should exist, found: ${danglingTmp.join(", ")}`);
  });
});

describe("concurrent session store interleaved operations", () => {
  test("concurrent ensure and delete operations do not throw or corrupt state", async () => {
    const { ensureQoderSession, deleteQoderSession, getQoderSession } = await import(DIST + "session-store.js");

    const ops = [];
    for (let i = 0; i < 30; i++) {
      const key = `interleave-${i}`;
      ops.push(
        ensureQoderSession(key, `sid-${i}`, `/tmp/${i}`).then(async () => {
          if (i % 2 === 0) {
            await deleteQoderSession(key);
          }
        })
      );
    }
    await Promise.all(ops);

    for (let i = 0; i < 30; i++) {
      const key = `interleave-${i}`;
      const rec = await getQoderSession(key);
      if (i % 2 === 0) {
        assert.equal(rec, null, `Key ${key} should have been deleted`);
      } else {
        assert.ok(rec, `Key ${key} should exist`);
      }
    }
  });
});

describe("tool normalizer edge cases & prototype safety", () => {
  test("normalizes delete, view, apply_diff and prevents prototype poisoning", async () => {
    const { normalizeToolInput, normalizeToolInputString } = await import(DIST + "tool-normalizer.js");

    assert.deepEqual(normalizeToolInput("delete", { file_path: "/a/b.ts" }), { filePath: "/a/b.ts" });
    assert.deepEqual(normalizeToolInput("view", { file_path: "/a/b.ts" }), { filePath: "/a/b.ts" });
    assert.deepEqual(normalizeToolInput("apply_diff", { file_path: "/a/b.ts" }), { filePath: "/a/b.ts" });

    // Prototype pollution payload in string
    const maliciousJson = '{"__proto__":{"polluted":true},"filePath":"safe.ts"}';
    const parsed = JSON.parse(normalizeToolInputString("read", maliciousJson));
    assert.equal(parsed.filePath, "safe.ts");
    assert.equal(Object.prototype.polluted, undefined);
  });
});
