import { chmodSync, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveStateDir } from "./state-dir.js";
import { debug, describeError } from "./logger.js";
const STATE_DIR = resolveStateDir();
const STATE_FILE = join(STATE_DIR, "usage.json");
const LOCK_FILE = join(STATE_DIR, "usage.lock");
const MAX_STATE_BYTES = 1_000_000;
const MAX_MODEL_LABEL = 256;
const LOCK_STALE_MS = 120_000;
const LOCK_ATTEMPTS = 80;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const RECENT_LIMIT = 50;
function emptyState() {
    return { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, turnCount: 0, byModel: Object.create(null), recent: [] };
}
function load() {
    try {
        const info = lstatSync(STATE_FILE);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) {
            debug("Cost ledger reset (missing, symlinked, or oversized state file)");
            return emptyState();
        }
        try {
            chmodSync(STATE_FILE, 0o600);
        }
        catch { /* readable state can still be used */ }
        const raw = readFileSync(STATE_FILE, "utf8");
        return sanitizeState(JSON.parse(raw));
    }
    catch (error) {
        const code = error?.code;
        if (code !== "ENOENT")
            debug("Cost ledger unreadable; starting empty:", describeError(error));
        return emptyState();
    }
}
function finiteNonNegative(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function safeModelLabel(value) {
    if (typeof value !== "string" || !value.trim() || UNSAFE_KEYS.has(value))
        return "unknown";
    return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_MODEL_LABEL);
}
function sanitizeState(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return emptyState();
    const raw = value;
    const clean = emptyState();
    clean.totalCostUsd = finiteNonNegative(raw.totalCostUsd);
    clean.totalInputTokens = finiteNonNegative(raw.totalInputTokens);
    clean.totalOutputTokens = finiteNonNegative(raw.totalOutputTokens);
    clean.turnCount = finiteNonNegative(raw.turnCount);
    if (typeof raw.byModel === "object" && raw.byModel !== null && !Array.isArray(raw.byModel)) {
        for (const [model, bucket] of Object.entries(raw.byModel)) {
            if (UNSAFE_KEYS.has(model))
                continue;
            if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket))
                continue;
            const b = bucket;
            clean.byModel[safeModelLabel(model)] = {
                costUsd: finiteNonNegative(b.costUsd),
                inputTokens: finiteNonNegative(b.inputTokens),
                outputTokens: finiteNonNegative(b.outputTokens),
                turns: finiteNonNegative(b.turns),
            };
        }
    }
    if (Array.isArray(raw.recent)) {
        clean.recent = raw.recent.slice(-RECENT_LIMIT).flatMap((entry) => {
            if (typeof entry !== "object" || entry === null || Array.isArray(entry))
                return [];
            const e = entry;
            if (typeof e.model !== "string")
                return [];
            return [{
                    model: safeModelLabel(e.model),
                    inputTokens: finiteNonNegative(e.inputTokens),
                    outputTokens: finiteNonNegative(e.outputTokens),
                    cacheReadTokens: finiteNonNegative(e.cacheReadTokens),
                    cacheWriteTokens: finiteNonNegative(e.cacheWriteTokens),
                    costUsd: finiteNonNegative(e.costUsd),
                    durationMs: finiteNonNegative(e.durationMs),
                    turns: finiteNonNegative(e.turns),
                    at: finiteNonNegative(e.at),
                }];
        });
    }
    return clean;
}
let state = null;
let writeTimer = null;
let dirty = false;
let exitHookInstalled = false;
let pendingEntries = [];
let resetRequested = false;
function current() {
    state ??= load();
    return state;
}
function withLedgerLock(fn) {
    try {
        mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    }
    catch {
        return undefined;
    }
    try {
        chmodSync(STATE_DIR, 0o700);
    }
    catch { /* best-effort */ }
    let fd;
    let ownerDevice;
    let ownerInode;
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
        try {
            fd = openSync(LOCK_FILE, "wx", 0o600);
            break;
        }
        catch (error) {
            if (error?.code !== "EEXIST")
                return undefined;
            try {
                const info = lstatSync(LOCK_FILE);
                if (info.isSymbolicLink())
                    return undefined;
                if (Date.now() - info.mtimeMs > LOCK_STALE_MS)
                    unlinkSync(LOCK_FILE);
            }
            catch { /* another writer may be replacing the lock */ }
            try {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
            }
            catch { /* best-effort delay */ }
        }
    }
    if (fd === undefined)
        return undefined;
    try {
        const owner = fstatSync(fd);
        ownerDevice = owner.dev;
        ownerInode = owner.ino;
    }
    catch {
        try {
            closeSync(fd);
        }
        catch { /* best-effort */ }
        try {
            unlinkSync(LOCK_FILE);
        }
        catch { /* best-effort */ }
        return undefined;
    }
    try {
        return fn();
    }
    finally {
        try {
            closeSync(fd);
        }
        catch { /* best-effort */ }
        try {
            const currentLock = lstatSync(LOCK_FILE);
            if (currentLock.dev === ownerDevice && currentLock.ino === ownerInode)
                unlinkSync(LOCK_FILE);
        }
        catch { /* best-effort */ }
    }
}
function applyEntry(target, entry) {
    target.totalCostUsd = safeAdd(target.totalCostUsd, entry.costUsd);
    target.totalInputTokens = safeAdd(target.totalInputTokens, entry.inputTokens);
    target.totalOutputTokens = safeAdd(target.totalOutputTokens, entry.outputTokens);
    target.turnCount = safeAdd(target.turnCount, 1);
    const bucket = Object.hasOwn(target.byModel, entry.model)
        ? target.byModel[entry.model]
        : (target.byModel[entry.model] = { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 });
    bucket.costUsd = safeAdd(bucket.costUsd, entry.costUsd);
    bucket.inputTokens = safeAdd(bucket.inputTokens, entry.inputTokens);
    bucket.outputTokens = safeAdd(bucket.outputTokens, entry.outputTokens);
    bucket.turns = safeAdd(bucket.turns, entry.turns);
    target.recent.push(entry);
    if (target.recent.length > RECENT_LIMIT)
        target.recent.splice(0, target.recent.length - RECENT_LIMIT);
}
function writeStateFile() {
    const written = withLedgerLock(() => {
        let temporary;
        let fd;
        try {
            const merged = resetRequested ? emptyState() : load();
            for (const entry of pendingEntries)
                applyEntry(merged, entry);
            mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
            chmodSync(STATE_DIR, 0o700);
            temporary = join(STATE_DIR, `.usage.${process.pid}.${randomUUID()}.tmp`);
            fd = openSync(temporary, "wx", 0o600);
            writeFileSync(fd, JSON.stringify(merged, null, 2), "utf8");
            fsyncSync(fd);
            closeSync(fd);
            fd = undefined;
            renameSync(temporary, STATE_FILE);
            temporary = undefined;
            state = merged;
            pendingEntries = [];
            resetRequested = false;
            return true;
        }
        catch (error) {
            debug("Cost ledger persist failed:", describeError(error));
            return false;
        }
        finally {
            if (fd !== undefined) {
                try {
                    closeSync(fd);
                }
                catch { /* best-effort */ }
            }
            if (temporary) {
                try {
                    unlinkSync(temporary);
                }
                catch { /* best-effort */ }
            }
        }
    });
    return written === true;
}
/**
 * The debounced timer is unref'd, so a fast-exiting host process would drop
 * the most recent turns. A synchronous flush on "exit" closes that gap.
 */
function installExitFlush() {
    if (exitHookInstalled)
        return;
    exitHookInstalled = true;
    process.on("exit", () => {
        if (!dirty)
            return;
        // Reuse the atomic writer so failed exits do not leave an orphaned temp
        // file and a failed write does not falsely clear the dirty flag.
        writeStateFile();
    });
}
function persist() {
    dirty = true;
    installExitFlush();
    if (writeTimer)
        return;
    writeTimer = setTimeout(() => {
        writeTimer = null;
        if (!dirty)
            return;
        if (writeStateFile())
            dirty = false;
    }, 250);
    if (typeof writeTimer.unref === "function")
        writeTimer.unref();
}
export function flushLedgerSync() {
    if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }
    if (!dirty)
        return;
    if (writeStateFile())
        dirty = false;
}
/** Record a completed turn into the persistent ledger. */
export function recordTurn(input) {
    const s = current();
    const model = safeModelLabel(input.model);
    const entry = {
        model,
        inputTokens: finiteNonNegative(input.usage?.input_tokens),
        outputTokens: finiteNonNegative(input.usage?.output_tokens),
        cacheReadTokens: finiteNonNegative(input.usage?.cache_read_input_tokens),
        cacheWriteTokens: finiteNonNegative(input.usage?.cache_creation_input_tokens),
        costUsd: finiteNonNegative(input.costUsd),
        durationMs: finiteNonNegative(input.durationMs),
        turns: finiteNonNegative(input.turns),
        at: Date.now(),
    };
    applyEntry(s, entry);
    pendingEntries.push(entry);
    persist();
    return entry;
}
export function summarize() {
    const s = current();
    return {
        totalCostUsd: s.totalCostUsd,
        totalInputTokens: s.totalInputTokens,
        totalOutputTokens: s.totalOutputTokens,
        turnCount: s.turnCount,
        byModel: s.byModel,
        recent: s.recent,
    };
}
export function resetLedger() {
    state = emptyState();
    pendingEntries = [];
    resetRequested = true;
    persist();
}
export function formatCost(usd) {
    return `$${finiteNonNegative(usd).toFixed(4)}`;
}
function safeAdd(left, right) {
    const value = left + right;
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}
//# sourceMappingURL=cost.js.map