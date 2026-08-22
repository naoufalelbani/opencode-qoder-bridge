import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveStateDir } from "./state-dir.js";
import { QoderSessionError } from "./errors.js";
import { debug, describeError } from "./logger.js";
const STATE_DIR = resolveStateDir();
const STATE_FILE = join(STATE_DIR, "sessions.json");
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
function validRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const record = value;
    return typeof record.qoderSessionId === "string"
        && typeof record.cwd === "string"
        && typeof record.createdAt === "string"
        && typeof record.lastUsedAt === "string";
}
async function load() {
    let raw;
    try {
        raw = await readFile(STATE_FILE, "utf8");
    }
    catch (error) {
        const code = error?.code;
        if (code !== "ENOENT")
            debug("Session store unreadable:", describeError(error));
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        const state = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (!UNSAFE_KEYS.has(key) && validRecord(value))
                state[key] = value;
        }
        return state;
    }
    catch (error) {
        debug("Session store held invalid JSON; starting empty:", describeError(error));
        return {};
    }
}
async function save(state) {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    const temporary = join(STATE_DIR, `.sessions.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, STATE_FILE);
}
export async function getQoderSession(key) {
    if (!key || UNSAFE_KEYS.has(key))
        return null;
    return (await load())[key] ?? null;
}
export async function ensureQoderSession(key, qoderSessionId, cwd) {
    if (!key || UNSAFE_KEYS.has(key))
        throw new QoderSessionError("Invalid Qoder session key");
    const state = await load();
    const now = new Date().toISOString();
    const existing = state[key];
    const record = existing ?? {
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
export async function deleteQoderSession(key) {
    if (!key || UNSAFE_KEYS.has(key))
        return;
    const state = await load();
    if (!(key in state))
        return;
    delete state[key];
    await save(state);
}
//# sourceMappingURL=session-store.js.map