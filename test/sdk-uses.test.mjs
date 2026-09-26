import { test, describe } from "node:test";
import assert from "node:assert/strict";

const DIST = new URL("../dist/", import.meta.url).href;
const AUTHED = { QODER_PERSONAL_ACCESS_TOKEN: "pt-sdk-uses-test" };

function fakeQuery(messages, { hang = false } = {}) {
  return {
    async next() {
      if (hang) return new Promise(() => {});
      return messages.length > 0 ? { value: messages.shift(), done: false } : { done: true };
    },
    async return() { return { done: true }; },
    [Symbol.asyncIterator]() { return this; },
  };
}

describe("SDK feature use", () => {
  test("maxTurns is forwarded when a positive integer", async () => {
    const { QoderLanguageModel } = await import(DIST + "language-model.js");
    const lm = new QoderLanguageModel("auto", { env: { ...AUTHED }, maxTurns: 7 });
    const opts = lm.buildQueryOptions(null, "s", new AbortController(), false);
    assert.equal(opts.maxTurns, 7);
  });

  test("maxTurns is omitted for invalid values", async () => {
    const { QoderLanguageModel } = await import(DIST + "language-model.js");
    for (const bad of [0, -3, 2.5, Number.NaN, "10"]) {
      const lm = new QoderLanguageModel("auto", { env: { ...AUTHED }, maxTurns: bad });
      const opts = lm.buildQueryOptions(null, "s", new AbortController(), false);
      assert.equal("maxTurns" in opts, false, `maxTurns=${String(bad)} must be omitted`);
    }
  });

  test("goalMaxTurns is forwarded when a positive integer, omitted otherwise", async () => {
    const { QoderLanguageModel } = await import(DIST + "language-model.js");
    const lm = new QoderLanguageModel("auto", { env: { ...AUTHED }, goalMaxTurns: 4 });
    assert.equal(lm.buildQueryOptions(null, "s", new AbortController(), false).goalMaxTurns, 4);
    const bad = new QoderLanguageModel("auto", { env: { ...AUTHED }, goalMaxTurns: 0 });
    assert.equal("goalMaxTurns" in bad.buildQueryOptions(null, "s", new AbortController(), false), false);
  });

  test("stderr is captured and SDK debug follows the explicit flag", async () => {
    const { QoderLanguageModel } = await import(DIST + "language-model.js");
    const plain = new QoderLanguageModel("auto", { env: { ...AUTHED } });
    const plainOpts = plain.buildQueryOptions(null, "s", new AbortController(), false);
    assert.equal(typeof plainOpts.stderr, "function");
    assert.equal("debug" in plainOpts, false);
    const verbose = new QoderLanguageModel("auto", { env: { ...AUTHED }, sdkDebug: true });
    assert.equal(verbose.buildQueryOptions(null, "s", new AbortController(), false).debug, true);
  });
  test("initTimeoutMs clamps to 10s..5min with 60s default", async () => {
    const { initTimeoutMs } = await import(DIST + "language-model.js");
    assert.equal(initTimeoutMs(undefined), 60_000);
    assert.equal(initTimeoutMs("soon"), 60_000);
    assert.equal(initTimeoutMs(1), 10_000);
    assert.equal(initTimeoutMs(30_000), 30_000);
    assert.equal(initTimeoutMs(999_999_999), 300_000);
  });

  test("permission_denied surfaces as assistant text, not a failure", async () => {
    const { QoderLanguageModel } = await import(DIST + "language-model.js");
    const lm = new QoderLanguageModel("auto", {
      env: { ...AUTHED },
      query: () => fakeQuery([
        { type: "system", subtype: "permission_denied", tool_name: "Bash", message: "denied by rule" },
        { type: "result", subtype: "success", result: "done", usage: {} },
      ]),
      timeoutMs: 5_000,
      maxDurationMs: 30_000,
    });
    const result = await lm.doGenerate({ prompt: [{ role: "user", content: "hi" }] });
    assert.match(JSON.stringify(result.content), /permission denied: Bash/);
  });

  test("init watchdog aborts a wedged runtime with guidance", { timeout: 30_000 }, async () => {
    const { QoderLanguageModel } = await import(DIST + "language-model.js");
    const lm = new QoderLanguageModel("auto", {
      env: { ...AUTHED },
      query: () => fakeQuery([], { hang: true }),
      timeoutMs: 5 * 60_000,
      maxDurationMs: 60 * 60_000,
      initTimeoutMs: 10_000,
    });
    // The bridge unrefs its timers (a watchdog must not hold the process
    // open), so hold the loop explicitly; the hanging query never resolves.
    // Keepalive outlives the test timeout so a broken watchdog fails by
    // timeout, not by loop drain.
    const keepalive = setTimeout(() => {}, 60_000);
    try {
      await assert.rejects(
        () => lm.doGenerate({ prompt: [{ role: "user", content: "hi" }] }),
        (error) => {
          assert.match(error.message, /did not start within 10000ms/);
          return true;
        },
      );
    } finally {
      clearTimeout(keepalive);
    }
  });
});
