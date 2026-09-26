import { test, describe } from "node:test";
import assert from "node:assert/strict";

const DIST = new URL("../dist/", import.meta.url).href;

describe("TUI render safety", () => {
  test("stale API reads degrade instead of throwing", async () => {
    const { safeApiRead } = await import(DIST + "tui.js");
    assert.equal(
      safeApiRead(false, () => {
        throw new Error("extension ctx is stale");
      }),
      false,
    );
    assert.equal(
      safeApiRead(0, () => {
        throw new TypeError("Cannot read properties of undefined");
      }),
      0,
    );
    assert.equal(
      safeApiRead("fallback", () => "live value"),
      "live value",
    );
  });
});
