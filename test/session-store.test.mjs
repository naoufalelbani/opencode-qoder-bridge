import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = await mkdtemp(join(tmpdir(), "qoder-bridge-session-test-"));
process.env.QODER_BRIDGE_STATE_DIR = stateDir;
const { ensureQoderSession, getQoderSession, deleteQoderSession } = await import("../dist/session-store.js");

after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

test("session store round-trips records and deletes them", async () => {
  assert.equal(await getQoderSession("project"), null);
  const saved = await ensureQoderSession("project", "session-id", "/project");
  assert.equal(saved.qoderSessionId, "session-id");
  const loaded = await getQoderSession("project");
  assert.deepEqual(loaded, saved);
  await deleteQoderSession("project");
  assert.equal(await getQoderSession("project"), null);
});

test("session store rejects unsafe keys", async () => {
  assert.equal(await getQoderSession("__proto__"), null);
  await assert.rejects(
    () => ensureQoderSession("constructor", "session-id", "/project"),
    /Invalid Qoder session key/,
  );
});
