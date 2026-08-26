import { query } from "@qoder-ai/qoder-agent-sdk";
import { findQoderCLI } from "./auth.js";
import { idlePrompt } from "./sdk-session.js";
import { hasQoderCredential, qoderAuth } from "./sdk-auth.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveStateDir } from "./state-dir.js";
import { debug, describeError } from "./logger.js";
const CONTEXT = 200_000;
const OUTPUT = 32_000;
function def(id, name, multiplier, opts = {}) {
    return {
        id,
        name,
        multiplier,
        attachment: opts.attachment ?? true,
        reasoning: opts.reasoning ?? false,
        toolCall: opts.toolCall ?? true,
        cost: {
            input: multiplier,
            output: multiplier,
            cacheRead: Number((multiplier * 0.1).toFixed(4)),
            cacheWrite: multiplier,
        },
        limit: { context: CONTEXT, output: OUTPUT },
    };
}
export const FALLBACK_MODELS = [
    def("lite", "Lite (free)", 0, { attachment: false }),
    def("auto", "Auto (1.0x)", 1.0),
    def("performance", "Performance (1.1x)", 1.1),
];
export const DEFAULT_MODEL_ID = "auto";
const MODEL_INDEX = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));
const STATE_DIR = resolveStateDir();
const MODEL_CACHE_FILE = join(STATE_DIR, "models.json");
function addToIndex(m) {
    MODEL_INDEX.set(m.id, {
        id: m.id,
        name: m.name,
        multiplier: m.cost.input,
        attachment: m.attachment,
        reasoning: m.reasoning,
        toolCall: m.toolCall,
        cost: {
            input: m.cost.input,
            output: m.cost.output,
            cacheRead: m.cost.cache_read,
            cacheWrite: m.cost.cache_write,
        },
        limit: m.limit,
    });
}
export function getModel(id) {
    return MODEL_INDEX.get(id);
}
/**
 * Keep catalog entries that are usable model ids. Disabled entries are
 * dropped; anything else (BYOK, tagged, scene-filtered) stays so the bridge
 * never hides a model the server actually serves.
 */
export function selectEnabledModels(models) {
    return models.filter((m) => !!m && typeof m.value === "string" && m.value.length > 0 && m.isEnabled !== false);
}
function mapModelInfo(m) {
    const factor = m.priceFactor ?? 1.0;
    const context = m.maxInputTokens ?? CONTEXT;
    const output = m.maxOutputTokens ?? OUTPUT;
    const vl = m.isVl ?? true;
    return {
        id: m.value,
        name: m.displayName,
        attachment: vl,
        reasoning: m.isReasoning ?? false,
        toolCall: true,
        limit: { context, output },
        cost: {
            input: factor,
            output: factor,
            cache_read: Number((factor * 0.1).toFixed(4)),
            cache_write: factor,
        },
        modalities: {
            input: vl ? ["text", "image"] : ["text"],
            output: ["text"],
        },
    };
}
let cachedDynamicModels = loadCachedModels();
function loadCachedModels() {
    try {
        if (!existsSync(MODEL_CACHE_FILE))
            return null;
        const parsed = JSON.parse(readFileSync(MODEL_CACHE_FILE, "utf8"));
        if (!Array.isArray(parsed))
            return null;
        const models = parsed.filter((m) => {
            if (!m || typeof m !== "object")
                return false;
            const x = m;
            return typeof x.id === "string" && typeof x.name === "string" && typeof x.attachment === "boolean"
                && typeof x.reasoning === "boolean" && typeof x.toolCall === "boolean" && typeof x.limit === "object"
                && typeof x.cost === "object" && typeof x.modalities === "object";
        });
        for (const model of models)
            addToIndex(model);
        return models.length > 0 ? models : null;
    }
    catch (error) {
        debug("Model cache unreadable; using fallback catalog:", describeError(error));
        return null;
    }
}
export function listModels() {
    return [...MODEL_INDEX.values()].map((m) => ({ ...m, cost: { ...m.cost }, limit: { ...m.limit } }));
}
export function getCachedDynamicModels() {
    return cachedDynamicModels;
}
let inflightFetch = null;
export async function fetchDynamicModels(force = false) {
    if (cachedDynamicModels && !force)
        return cachedDynamicModels;
    if (inflightFetch)
        return inflightFetch;
    inflightFetch = doFetchDynamicModels().finally(() => {
        inflightFetch = null;
    });
    return inflightFetch;
}
async function writeCacheFile(models) {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    try {
        chmodSync(STATE_DIR, 0o700);
    }
    catch { /* best-effort */ }
    const temporary = join(STATE_DIR, `.models.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(models, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, MODEL_CACHE_FILE);
}
async function doFetchDynamicModels() {
    const cli = findQoderCLI();
    if (!hasQoderCredential())
        return null;
    let q;
    const abortController = new AbortController();
    const sceneEnv = process.env.QODER_SCENE
        ? { env: { QODER_SCENE: process.env.QODER_SCENE } }
        : {};
    try {
        q = query({
            prompt: idlePrompt(abortController.signal),
            options: {
                auth: qoderAuth(),
                model: "auto",
                abortController,
                ...(cli ? { pathToQoderCLIExecutable: cli } : {}),
                ...sceneEnv,
            },
        });
        // "live" forces a server refresh inside the CLI and falls back to the
        // CLI's cached catalog when the server returns nothing. The previous
        // "cache" strategy could serve an empty or stale subset, which hid
        // models until a lucky refresh.
        const models = await q.getAvailableModels({ fetchStrategy: "live" });
        if (!Array.isArray(models))
            return null;
        const enabled = selectEnabledModels(models);
        debug(`Model catalog: ${enabled.length} usable of ${models.length} reported`
            + (enabled.length === 0 ? "" : ` (${enabled.map((m) => m.value).join(", ")})`));
        if (enabled.length === 0)
            return null;
        cachedDynamicModels = enabled.map(mapModelInfo);
        for (const m of cachedDynamicModels)
            addToIndex(m);
        await writeCacheFile(cachedDynamicModels).catch((error) => {
            debug("Model cache write failed:", describeError(error));
        });
        return cachedDynamicModels;
    }
    catch (error) {
        debug("Live model catalog unavailable; keeping cached/fallback models:", describeError(error));
        return null;
    }
    finally {
        abortController.abort();
        try {
            await q?.return(undefined);
        }
        catch { /* ignore */ }
    }
}
//# sourceMappingURL=models.js.map