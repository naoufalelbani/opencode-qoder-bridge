import { FALLBACK_MODELS, fetchDynamicModels, getCachedDynamicModels, listModels } from "./models.js";
import { findQoderCLI } from "./auth.js";
import { hasQoderCredential, hasQoderPAT, QODER_PAT_ENV } from "./sdk-auth.js";
import { bridgeMcpServers } from "./mcp-bridge.js";
import { getLiveUsage, formatUsageReport } from "./usage.js";
import { summarize, formatCost } from "./cost.js";
import { ensureTuiRegistered } from "./tui-register.js";
import { deleteQoderSession } from "./session-store.js";
import { debug, describeError, isDebugEnabled, warn } from "./logger.js";
const PROVIDER_URL = new URL("./provider.js", import.meta.url).href;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
let configuredSessionKey;
function buildFallbackEntry(m) {
    return {
        name: m.name,
        attachment: m.attachment,
        reasoning: m.reasoning,
        temperature: false,
        tool_call: m.toolCall,
        limit: { context: m.limit.context, output: m.limit.output },
        cost: {
            input: m.cost.input,
            output: m.cost.output,
            cache_read: m.cost.cacheRead,
            cache_write: m.cost.cacheWrite,
        },
        modalities: {
            input: m.attachment ? ["text", "image"] : ["text"],
            output: ["text"],
        },
    };
}
function buildDynamicEntry(m) {
    return {
        name: m.name,
        attachment: m.attachment,
        reasoning: m.reasoning,
        temperature: false,
        tool_call: m.toolCall,
        limit: m.limit,
        cost: m.cost,
        modalities: m.modalities,
    };
}
const plugin = async (input) => {
    if (input) {
        if (isDebugEnabled())
            debug("Plugin initializing");
        try {
            const result = await ensureTuiRegistered();
            if (result === "added") {
                console.info("[opencode-qoder-bridge] Registered Qoder sidebar; restart OpenCode to activate it.");
            }
        }
        catch (error) {
            warn("Could not register Qoder sidebar:", error);
        }
    }
    return {
        async config(config) {
            config.provider ??= {};
            const existing = (config.provider.qoder ?? {});
            const builtinModels = {};
            // Use cached/fallback models immediately. Refresh the catalog in the
            // background so OpenCode startup never waits on network/auth discovery.
            const dynamic = getCachedDynamicModels();
            if (dynamic) {
                for (const m of dynamic) {
                    if (!UNSAFE_KEYS.has(m.id))
                        builtinModels[m.id] = buildDynamicEntry(m);
                }
            }
            // Keep the provider usable when the live catalog is partial or offline.
            // Dynamic entries remain authoritative for IDs returned by the SDK.
            for (const m of FALLBACK_MODELS) {
                if (!UNSAFE_KEYS.has(m.id) && !builtinModels[m.id])
                    builtinModels[m.id] = buildFallbackEntry(m);
            }
            void fetchDynamicModels(true).catch((error) => {
                debug("Background model refresh failed:", describeError(error));
            });
            const mergedModels = { ...builtinModels, ...(existing.models ?? {}) };
            const bridgedMcp = bridgeMcpServers(config.mcp);
            const mergedOptions = { ...(existing.options ?? {}) };
            configuredSessionKey = typeof mergedOptions.sessionKey === "string" ? mergedOptions.sessionKey : undefined;
            if (Object.keys(bridgedMcp).length > 0) {
                mergedOptions.mcpServers = {
                    ...(existing.options?.mcpServers ?? {}),
                    ...bridgedMcp,
                };
            }
            config.provider.qoder = {
                ...existing,
                npm: existing.npm ?? PROVIDER_URL,
                name: existing.name ?? "Qoder",
                options: mergedOptions,
                models: mergedModels,
            };
        },
        auth: {
            provider: "qoder",
            async loader() {
                return {};
            },
            methods: [
                {
                    type: "api",
                    label: `Use ${QODER_PAT_ENV} or run qoder login in your terminal`,
                    prompts: [],
                    async authorize() {
                        if (!findQoderCLI() && !hasQoderPAT()) {
                            warn("Authorize failed: qodercli not found on PATH and no", `${QODER_PAT_ENV} is set. Install the CLI (https://docs.qoder.com/cli)`, "or export a personal access token, then retry.");
                            return { type: "failed" };
                        }
                        if (hasQoderCredential()) {
                            return { type: "success", key: "qoder-cli-auth" };
                        }
                        warn("Authorize failed: no usable Qoder credential found.");
                        return { type: "failed" };
                    },
                },
            ],
        },
        tool: {
            qoder_usage: {
                description: "Show Qoder account usage and quota (live), plus accumulated session cost and token totals from the local ledger.",
                args: {},
                async execute() {
                    const lines = [];
                    const live = await getLiveUsage();
                    lines.push(live ? formatUsageReport(live) : "Live usage unavailable (not logged in or CLI missing).");
                    const s = summarize();
                    lines.push("");
                    lines.push("Local Cost Ledger");
                    lines.push(`  Total cost: ${formatCost(s.totalCostUsd)}`);
                    lines.push(`  Turns: ${s.turnCount}`);
                    lines.push(`  Tokens: ${s.totalInputTokens} in / ${s.totalOutputTokens} out`);
                    const models = Object.entries(s.byModel);
                    if (models.length > 0) {
                        lines.push("  By model:");
                        for (const [name, b] of models) {
                            lines.push(`    ${name}: ${formatCost(b.costUsd)} (${b.turns} turns)`);
                        }
                    }
                    return { title: "Qoder Usage", output: lines.join("\n") };
                },
            },
            qoder_models: {
                description: "List known Qoder models, capabilities, limits, and price multipliers.",
                args: {},
                async execute() {
                    const models = listModels();
                    const lines = ["Qoder Models"];
                    for (const model of models) {
                        lines.push(`  ${model.id}: ${model.name}`);
                        lines.push(`    context ${model.limit.context}, output ${model.limit.output}, price ${model.multiplier}x`);
                        lines.push(`    vision ${model.attachment ? "yes" : "no"}, reasoning ${model.reasoning ? "yes" : "no"}`);
                    }
                    return { title: "Qoder Models", output: lines.join("\n") };
                },
            },
            qoder_session_reset: {
                description: "Forget the persisted Qoder session mapping for the configured session key.",
                args: {},
                async execute() {
                    if (!configuredSessionKey) {
                        return { title: "Qoder Session", output: "No sessionKey is configured; no persisted session was reset." };
                    }
                    await deleteQoderSession(configuredSessionKey);
                    return { title: "Qoder Session", output: `Reset persisted Qoder session: ${configuredSessionKey}` };
                },
            },
        },
    };
};
export default plugin;
//# sourceMappingURL=index.js.map