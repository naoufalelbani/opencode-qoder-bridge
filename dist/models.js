import { query } from "@qoder-ai/qoder-agent-sdk";
import { findQoderCLI } from "./auth.js";
import { idlePrompt } from "./sdk-session.js";
import { hasQoderPAT, qoderAuth } from "./sdk-auth.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
const MODEL_CACHE_FILE = join(homedir(), ".config", "opencode-qoder-bridge", "models.json");
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
    catch {
        return null;
    }
}
export function listModels() {
    return [...MODEL_INDEX.values()].map((m) => ({ ...m, cost: { ...m.cost }, limit: { ...m.limit } }));
}
export function getCachedDynamicModels() {
    return cachedDynamicModels;
}
export async function fetchDynamicModels(force = false) {
    if (cachedDynamicModels && !force)
        return cachedDynamicModels;
    const cli = findQoderCLI();
    if (!cli && !hasQoderPAT())
        return null;
    let q;
    const abortController = new AbortController();
    try {
        q = query({
            prompt: idlePrompt(abortController.signal),
            options: {
                auth: qoderAuth(),
                model: "auto",
                abortController,
                ...(cli ? { pathToQoderCLIExecutable: cli } : {}),
            },
        });
        const models = await q.getAvailableModels({ fetchStrategy: "cache" });
        if (!models || models.length === 0)
            return null;
        const enabled = models.filter((m) => m.isEnabled !== false);
        cachedDynamicModels = enabled.map(mapModelInfo);
        for (const m of cachedDynamicModels)
            addToIndex(m);
        try {
            mkdirSync(join(homedir(), ".config", "opencode-qoder-bridge"), { recursive: true, mode: 0o700 });
        }
        catch { /* ignore */ }
        void writeFile(MODEL_CACHE_FILE, JSON.stringify(cachedDynamicModels, null, 2) + "\n", { mode: 0o600 }).catch(() => { });
        return cachedDynamicModels;
    }
    catch {
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