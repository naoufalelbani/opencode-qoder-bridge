import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = process.env.QODER_BRIDGE_STATE_DIR
  ? join(process.env.QODER_BRIDGE_STATE_DIR)
  : join(homedir(), ".config", "opencode-qoder-bridge");
const STATE_FILE = join(STATE_DIR, "sessions.json");
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export interface QoderSessionRecord {
  qoderSessionId: string;
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
}

type SessionState = Record<string, QoderSessionRecord>;

function validRecord(value: unknown): value is QoderSessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.qoderSessionId === "string"
    && typeof record.cwd === "string"
    && typeof record.createdAt === "string"
    && typeof record.lastUsedAt === "string";
}

async function load(): Promise<SessionState> {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const state: SessionState = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!UNSAFE_KEYS.has(key) && validRecord(value)) state[key] = value;
    }
    return state;
  } catch {
    return {};
  }
}

async function save(state: SessionState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = join(STATE_DIR, `.sessions.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, STATE_FILE);
}

export async function getQoderSession(key: string): Promise<QoderSessionRecord | null> {
  if (!key || UNSAFE_KEYS.has(key)) return null;
  return (await load())[key] ?? null;
}

export async function ensureQoderSession(
  key: string,
  qoderSessionId: string,
  cwd: string,
): Promise<QoderSessionRecord> {
  if (!key || UNSAFE_KEYS.has(key)) throw new Error("Invalid Qoder session key");
  const state = await load();
  const now = new Date().toISOString();
  const existing = state[key];
  const record: QoderSessionRecord = existing ?? {
    qoderSessionId,
    cwd,
    createdAt: now,
    lastUsedAt: now,
  };
  record.lastUsedAt = now;
  state[key] = record;
  await save(state);
  return record;
}

export async function deleteQoderSession(key: string): Promise<void> {
  if (!key || UNSAFE_KEYS.has(key)) return;
  const state = await load();
  if (!(key in state)) return;
  delete state[key];
  await save(state);
}
