import { query, qodercliAuth } from "@qoder-ai/qoder-agent-sdk";
import { findQoderCLI } from "./auth.js";
import { idlePrompt } from "./sdk-session.js";
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
let cachedDynamicModels = null;
export async function fetchDynamicModels() {
    if (cachedDynamicModels)
        return cachedDynamicModels;
    const cli = findQoderCLI();
    if (!cli)
        return null;
    let q;
    const abortController = new AbortController();
    try {
        q = query({
            prompt: idlePrompt(abortController.signal),
            options: {
                auth: qodercliAuth(),
                model: "auto",
                pathToQoderCLIExecutable: cli,
                abortController,
            },
        });
        const models = await q.getAvailableModels({ fetchStrategy: "cache" });
        if (!models || models.length === 0)
            return null;
        const enabled = models.filter((m) => m.isEnabled !== false);
        cachedDynamicModels = enabled.map(mapModelInfo);
        for (const m of enabled) {
            const factor = m.priceFactor ?? 1.0;
            MODEL_INDEX.set(m.value, {
                id: m.value,
                name: m.displayName,
                multiplier: factor,
                attachment: m.isVl ?? true,
                reasoning: m.isReasoning ?? false,
                toolCall: true,
                cost: {
                    input: factor,
                    output: factor,
                    cacheRead: Number((factor * 0.1).toFixed(4)),
                    cacheWrite: factor,
                },
                limit: { context: m.maxInputTokens ?? CONTEXT, output: m.maxOutputTokens ?? OUTPUT },
            });
        }
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