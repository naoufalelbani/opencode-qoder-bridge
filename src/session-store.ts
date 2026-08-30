import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveStateDir } from "./state-dir.js";
import { QoderSessionError } from "./errors.js";
import { debug, describeError } from "./logger.js";

const STATE_DIR = resolveStateDir();
const STATE_FILE = join(STATE_DIR, "sessions.json");
const LOCK_FILE = join(STATE_DIR, "sessions.lock");
const RESET_FILE = join(STATE_DIR, "sessions.reset");
const MAX_STATE_BYTES = 1_000_000;
const MAX_RESET_BYTES = 128;
const LOCK_STALE_MS = 120_000;
const LOCK_ATTEMPTS = 80;
const SESSION_LEASE_STALE_MS = 2 * 60 * 1000;
const SESSION_LEASE_HEARTBEAT_MS = 30_000;
const SESSION_LEASE_ATTEMPTS = 4_320_000;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SCOPED_SEPARATOR = "\u0000";
const SCOPED_HASH = /^[a-f0-9]{64}$/;

export interface QoderSessionRecord {
  qoderSessionId: string;
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
}

type SessionState = Record<string, QoderSessionRecord>;

function emptyState(): SessionState {
  return Object.create(null) as SessionState;
}

let queue = Promise.resolve();
const sessionLeaseQueues = new Map<string, Promise<void>>();

type LoadedState = {
  state: SessionState;
  writable: boolean;
};

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.then(() => {}, () => {});
  return result;
}

function waitForPrevious(previous: Promise<void>, signal: AbortSignal | undefined): Promise<boolean> {
  if (!signal) return previous.then(() => true, () => true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolveResult(ready);
    };
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(() => finish(true), () => finish(true));
    if (signal.aborted) finish(false);
  });
}

async function withLeaseFile<T>(lockPath: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T | undefined> {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  try { await chmod(STATE_DIR, 0o700); } catch { /* best-effort */ }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < SESSION_LEASE_ATTEMPTS; attempt++) {
    if (signal?.aborted) return undefined;
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        const info = await lstat(lockPath);
        if (info.isSymbolicLink()) throw new QoderSessionError("Invalid Qoder session lease");
        if (Date.now() - info.mtimeMs > SESSION_LEASE_STALE_MS) await unlink(lockPath);
      } catch (lockError) {
        if (lockError instanceof QoderSessionError) throw lockError;
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  if (!handle) throw new QoderSessionError("Could not acquire the Qoder session lease");

  // Keep an active lease fresh so a long-running turn does not look like a
  // crashed process. The inode check in finally prevents an old owner from
  // unlinking a replacement lock if stale recovery had to take over.
  try { await handle.writeFile(randomUUID(), "utf8"); } catch { /* lock ownership is still represented by the open file */ }
  const heartbeat = setInterval(() => {
    void handle?.utimes(new Date(), new Date()).catch(() => undefined);
  }, SESSION_LEASE_HEARTBEAT_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    let ownsLock = false;
    try {
      const [pathInfo, handleInfo] = await Promise.all([lstat(lockPath), handle.stat()]);
      ownsLock = pathInfo.dev === handleInfo.dev && pathInfo.ino === handleInfo.ino;
    } catch { /* lock was already replaced or removed */ }
    try { await handle.close(); } catch { /* best-effort */ }
    if (ownsLock) {
      try { await unlink(lockPath); } catch { /* best-effort */ }
    }
  }
}

function leasePath(key: string, cwd: string): string {
  const digest = createHash("sha256").update(`${normalizedCwd(cwd)}\u0000${key}`).digest("hex");
  return join(STATE_DIR, `.session-${digest}.lock`);
}

/**
 * Serialize a persisted/explicit Qoder session across both threads and OS
 * processes. The lease covers the SDK turn, not just the JSON mapping write.
 */
export function withQoderSessionLease<T>(
  key: string,
  cwd: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  if (!validKey(key)) return Promise.reject(new QoderSessionError("Invalid Qoder session lease key"));
  const localKey = `${normalizedCwd(cwd)}\u0000${key}`;
  const previous = sessionLeaseQueues.get(localKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
  sessionLeaseQueues.set(localKey, current);

  const releaseAndClean = () => {
    release();
    if (sessionLeaseQueues.get(localKey) === current) sessionLeaseQueues.delete(localKey);
  };

  return waitForPrevious(previous, signal).then(async (acquired) => {
    if (!acquired) {
      void previous.then(releaseAndClean, releaseAndClean);
      return undefined;
    }
    try {
      if (signal?.aborted) return undefined;
      return await withLeaseFile(leasePath(key, cwd), signal, fn);
    } finally {
      releaseAndClean();
    }
  });
}

async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  try { await chmod(STATE_DIR, 0o700); } catch { /* best-effort */ }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      handle = await open(LOCK_FILE, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        const info = await lstat(LOCK_FILE);
        if (info.isSymbolicLink()) throw new QoderSessionError("Invalid Qoder session lock");
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(LOCK_FILE);
      } catch (lockError) {
        if (lockError instanceof QoderSessionError) throw lockError;
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  if (!handle) throw new QoderSessionError("Could not acquire the Qoder session store lock");

  try {
    return await fn();
  } finally {
    try { await handle.close(); } catch { /* best-effort */ }
    try { await unlink(LOCK_FILE); } catch { /* best-effort */ }
  }
}

function validRecord(value: unknown): value is QoderSessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.qoderSessionId === "string"
    && record.qoderSessionId.length > 0
    && record.qoderSessionId.length <= 512
    && typeof record.cwd === "string"
    && record.cwd.length > 0
    && record.cwd.length <= 4096
    && typeof record.createdAt === "string"
    && typeof record.lastUsedAt === "string";
}

function validKey(key: unknown): key is string {
  return typeof key === "string"
    && key.trim().length > 0
    && key.length <= 512
    && !/[\u0000-\u001f\u007f-\u009f]/.test(key)
    && !UNSAFE_KEYS.has(key);
}

function scopedStateKey(key: string, cwd: string): string {
  return `${key}${SCOPED_SEPARATOR}${createHash("sha256").update(normalizedCwd(cwd)).digest("hex")}`;
}

function validStateKey(key: unknown): key is string {
  if (validKey(key)) return true;
  if (typeof key !== "string") return false;
  const separator = key.indexOf(SCOPED_SEPARATOR);
  return separator > 0
    && validKey(key.slice(0, separator))
    && SCOPED_HASH.test(key.slice(separator + SCOPED_SEPARATOR.length));
}

function scopedKeys(state: SessionState, key: string): string[] {
  const prefix = `${key}${SCOPED_SEPARATOR}`;
  return Object.keys(state).filter((stateKey) => stateKey.startsWith(prefix) && validStateKey(stateKey));
}

function recordForCwd(state: SessionState, key: string, cwd: string): { stateKey: string; record: QoderSessionRecord } | null {
  const targetCwd = normalizedCwd(cwd);
  const scopedKey = scopedStateKey(key, targetCwd);
  const scoped = Object.hasOwn(state, scopedKey) ? state[scopedKey] : undefined;
  if (scoped && normalizedCwd(scoped.cwd) === targetCwd) return { stateKey: scopedKey, record: scoped };

  // Read the pre-workspace-scoping format for migration/compatibility. It is
  // only eligible when its stored cwd matches the requested workspace.
  const legacy = Object.hasOwn(state, key) ? state[key] : undefined;
  if (legacy && normalizedCwd(legacy.cwd) === targetCwd) return { stateKey: key, record: legacy };
  return null;
}

function normalizedCwd(cwd: string): string {
  try {
    const resolved = resolve(cwd);
    try { return realpathSync(resolved); } catch { return resolved; }
  } catch { return cwd; }
}

async function load(): Promise<LoadedState> {
  try {
    const info = await lstat(STATE_FILE);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) {
      return { state: emptyState(), writable: false };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { state: emptyState(), writable: true };
    debug("Session store stat failed:", describeError(error));
    return { state: emptyState(), writable: false };
  }

  let raw: string;
  try {
    raw = await readFile(STATE_FILE, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { state: emptyState(), writable: true };
    debug("Session store unreadable:", describeError(error));
    return { state: emptyState(), writable: false };
  }
  try {
    if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) return { state: emptyState(), writable: false };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: emptyState(), writable: false };
    }
    const state = emptyState();
    let valid = true;
    for (const [key, value] of Object.entries(parsed)) {
      if (validStateKey(key) && validRecord(value)) state[key] = value;
      else valid = false;
    }
    // Keep usable entries available for reads, but never rewrite a file that
    // contains an entry we could not validate; doing so would silently delete
    // data added by a newer bridge version or a partially corrupted write.
    return { state, writable: valid };
  } catch (error) {
    debug("Session store held invalid JSON; starting empty:", describeError(error));
    return { state: emptyState(), writable: false };
  }
}

async function save(state: SessionState): Promise<void> {
  let temporary: string | undefined;
  try {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    try { await chmod(STATE_DIR, 0o700); } catch { /* best-effort */ }
    temporary = join(STATE_DIR, `.sessions.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    try { await chmod(temporary, 0o600); } catch { /* best-effort */ }
    await rename(temporary, STATE_FILE);
    temporary = undefined;
  } finally {
    if (temporary) {
      try { await unlink(temporary); } catch { /* best-effort */ }
    }
  }
}

async function readResetEpoch(): Promise<string> {
  try {
    const info = await lstat(RESET_FILE);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RESET_BYTES) return "invalid";
    return (await readFile(RESET_FILE, "utf8")).trim().slice(0, MAX_RESET_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    debug("Session reset marker unreadable:", describeError(error));
    return "invalid";
  }
}

async function writeResetEpoch(epoch: string): Promise<void> {
  let temporary: string | undefined;
  try {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    try { await chmod(STATE_DIR, 0o700); } catch { /* best-effort */ }
    temporary = join(STATE_DIR, `.sessions-reset.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${epoch}\n`, { mode: 0o600 });
    try { await chmod(temporary, 0o600); } catch { /* best-effort */ }
    await rename(temporary, RESET_FILE);
    temporary = undefined;
  } finally {
    if (temporary) {
      try { await unlink(temporary); } catch { /* best-effort */ }
    }
  }
}

/** Read the generation used to fence reset-all against in-flight writes. */
export function getQoderSessionResetEpoch(): Promise<string> {
  return readResetEpoch();
}

export async function getQoderSession(key: string, cwd?: string): Promise<QoderSessionRecord | null> {
  if (!validKey(key)) return null;
  return withLock(() => withFileLock(async () => {
    const { state } = await load();
    if (cwd) return recordForCwd(state, key, cwd)?.record ?? null;
    const legacy = Object.hasOwn(state, key) ? state[key] : undefined;
    if (legacy) return legacy;
    const matches = scopedKeys(state, key).map((stateKey) => state[stateKey]);
    // The legacy API has no workspace argument. Returning an unambiguous
    // scoped record keeps old callers working without selecting another
    // workspace's session when a key is reused.
    return matches.length === 1 ? matches[0] : null;
  }));
}

export async function getQoderSessionForCwd(key: string, cwd: string): Promise<QoderSessionRecord | null> {
  return getQoderSession(key, cwd);
}

export function ensureQoderSession(
  key: string,
  qoderSessionId: string,
  cwd: string,
  expectedResetEpoch?: string,
): Promise<QoderSessionRecord> {
  if (!validKey(key) || typeof qoderSessionId !== "string" || !qoderSessionId || qoderSessionId.length > 512
    || typeof cwd !== "string" || !cwd || cwd.length > 4096) {
    return Promise.reject(new QoderSessionError("Invalid Qoder session key or session record"));
  }
  return withLock(() => withFileLock(async () => {
    const loaded = await load();
    if (!loaded.writable) {
      throw new QoderSessionError("Qoder session state is invalid or unreadable; refusing to overwrite it");
    }
    if (expectedResetEpoch === "invalid" || (expectedResetEpoch !== undefined && await readResetEpoch() !== expectedResetEpoch)) {
      throw new QoderSessionError("Qoder session reset superseded this request; refusing to recreate the mapping");
    }
    const state = loaded.state;
    const now = new Date().toISOString();
    const targetCwd = normalizedCwd(cwd);
    const targetKey = scopedStateKey(key, targetCwd);
    const existingMapping = recordForCwd(state, key, targetCwd);
    const existing = existingMapping?.record;
    const record: QoderSessionRecord = existing ?? {
      qoderSessionId,
      cwd: targetCwd,
      createdAt: now,
      lastUsedAt: now,
    };
    record.cwd = targetCwd;
    record.lastUsedAt = now;
    if (existingMapping?.stateKey === key) delete state[key];
    state[targetKey] = record;
    await save(state);
    return record;
  }));
}

export function deleteQoderSession(key: string, cwd?: string): Promise<void> {
  if (!validKey(key)) return Promise.resolve();
  return withLock(() => withFileLock(async () => {
    const loaded = await load();
    if (!loaded.writable) {
      throw new QoderSessionError("Qoder session state is invalid or unreadable; refusing to overwrite it");
    }
    const state = loaded.state;
    if (cwd) {
      const mapping = recordForCwd(state, key, cwd);
      if (mapping) delete state[mapping.stateKey];
      await save(state);
      return;
    }
    delete state[key];
    for (const stateKey of scopedKeys(state, key)) delete state[stateKey];
    await save(state);
  }));
}

/** Delete a mapping after waiting for any active turn in the same workspace. */
export async function deleteQoderSessionForCwd(key: string, cwd: string, leaseKey = key): Promise<void> {
  const abortController = new AbortController();
  const waitTimer = setTimeout(() => abortController.abort(), 10_000);
  if (typeof waitTimer.unref === "function") waitTimer.unref();
  try {
    const completed = await withQoderSessionLease(leaseKey, cwd, abortController.signal, async () => {
      await deleteQoderSession(key, cwd);
      return true;
    });
    if (completed !== true) throw new QoderSessionError("Could not reset the Qoder session while it was active");
  } finally {
    clearTimeout(waitTimer);
  }
}

export function clearAllSessions(): Promise<void> {
  return withLock(() => withFileLock(async () => {
    // Advance the fence before replacing the mapping. Requests that started
    // under the previous epoch will be refused by ensureQoderSession even if
    // they finish after this reset.
    await writeResetEpoch(randomUUID());
    await save(emptyState());
  }));
}
