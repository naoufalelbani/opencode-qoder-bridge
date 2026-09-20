import { test } from "node:test";
import assert from "node:assert/strict";

const { handleSdkMessage } = await import(new URL("../dist/language-model.js", import.meta.url));

function state() {
  const parts = [];
  return {
    controller: { enqueue(part) { parts.push(part); }, close() {} },
    contextWindow: 128_000,
    functionToolNames: new Set(),
    activeText: new Set(), activeReasoning: new Set(), toolBlocks: new Map(),
    closedBlockIndexes: new Set(), openBlocks: [], sawStreamText: false,
    sawStreamTool: false, sawStreamReasoning: false, emittedToolCall: false,
    pendingToolCalls: new Map(), lastStopReason: null, blockCounter: 0,
    outputChars: 0, finished: false, resultReceived: false,
    seenToolCallIds: new Set(), seenMessageIds: new Set(), artifacts: [], parts,
  };
}

test("representative SDK text contract produces one finished response", () => {
  const s = state();
  handleSdkMessage({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } }, s);
  handleSdkMessage({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } } }, s);
  handleSdkMessage({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }, s);
  handleSdkMessage({ type: "result", subtype: "success", usage: {} }, s);
  assert.equal(s.parts.filter((part) => part.type === "finish").length, 1);
  assert.equal(s.parts.filter((part) => part.type === "text-delta")[0].delta, "OK");
});

test("unknown future SDK messages are ignored without corrupting open state", () => {
  const s = state();
  handleSdkMessage({ type: "future_qoder_event", payload: { version: 99 } }, s);
  assert.equal(s.finished, false);
  assert.equal(s.parts.length, 0);
});
