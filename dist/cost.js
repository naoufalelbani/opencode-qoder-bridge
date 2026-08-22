import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveStateDir } from "./state-dir.js";
import { debug, describeError } from "./logger.js";
const STATE_DIR = resolveStateDir();
const STATE_FILE = join(STATE_DIR, "usage.json");
const MAX_STATE_BYTES = 1_000_000;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const RECENT_LIMIT = 50;
function emptyState() {
    return { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, turnCount: 0, byModel: {}, recent: [] };
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
            clean.byModel[model] = {
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
                    model: e.model,
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
function current() {
    state ??= load();
    return state;
}
function writeStateFile() {
    let temporary;
    let fd;
    try {
        mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
        chmodSync(STATE_DIR, 0o700);
        temporary = join(STATE_DIR, `.usage.${process.pid}.${randomUUID()}.tmp`);
        fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, JSON.stringify(current(), null, 2), "utf8");
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, STATE_FILE);
        temporary = undefined;
    }
    catch (error) {
        debug("Cost ledger persist failed:", describeError(error));
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
        dirty = false;
        try {
            mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
            const temporary = join(STATE_DIR, `.usage.${process.pid}.${randomUUID()}.exit.tmp`);
            const fd = openSync(temporary, "wx", 0o600);
            try {
                writeFileSync(fd, JSON.stringify(current(), null, 2), "utf8");
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            renameSync(temporary, STATE_FILE);
        }
        catch {
            /* nothing left to do during exit */
        }
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
        dirty = false;
        writeStateFile();
    }, 250);
    if (typeof writeTimer.unref === "function")
        writeTimer.unref();
}
/** Record a completed turn into the persistent ledger. */
export function recordTurn(input) {
    const s = current();
    const model = UNSAFE_KEYS.has(input.model) ? "unknown" : input.model;
    const entry = {
        model,
        inputTokens: finiteNonNegative(input.usage.input_tokens),
        outputTokens: finiteNonNegative(input.usage.output_tokens),
        cacheReadTokens: finiteNonNegative(input.usage.cache_read_input_tokens),
        cacheWriteTokens: finiteNonNegative(input.usage.cache_creation_input_tokens),
        costUsd: finiteNonNegative(input.costUsd),
        durationMs: finiteNonNegative(input.durationMs),
        turns: finiteNonNegative(input.turns),
        at: Date.now(),
    };
    s.totalCostUsd += entry.costUsd;
    s.totalInputTokens += entry.inputTokens;
    s.totalOutputTokens += entry.outputTokens;
    s.turnCount += 1;
    const bucket = (s.byModel[model] ??= { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 });
    bucket.costUsd += entry.costUsd;
    bucket.inputTokens += entry.inputTokens;
    bucket.outputTokens += entry.outputTokens;
    bucket.turns += entry.turns;
    s.recent.push(entry);
    if (s.recent.length > RECENT_LIMIT)
        s.recent.splice(0, s.recent.length - RECENT_LIMIT);
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
    persist();
}
export function formatCost(usd) {
    return `$${usd.toFixed(4)}`;
}
//# sourceMappingURL=cost.js.map