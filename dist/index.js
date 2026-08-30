import { tool } from "@opencode-ai/plugin";
import { listSessions } from "@qoder-ai/qoder-agent-sdk";
import { FALLBACK_MODELS, fetchDynamicModels, getCachedDynamicModels, listModels } from "./models.js";
import { hasQoderCredential, QODER_PAT_ENV } from "./sdk-auth.js";
import { bridgeMcpServers } from "./mcp-bridge.js";
import { getLiveUsage, formatUsageReport } from "./usage.js";
import { summarize, formatCost } from "./cost.js";
import { ensureTuiRegistered } from "./tui-register.js";
import { clearAllSessions, deleteQoderSessionForCwd } from "./session-store.js";
import { debug, describeError, isDebugEnabled, warn } from "./logger.js";
const PROVIDER_URL = new URL("./provider.js", import.meta.url).href;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MODEL_REFRESH_INTERVAL_MS = 60_000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
let lastModelRefreshAt = 0;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeDisplay(value, fallback, maxLength = 512) {
    if (typeof value !== "string" || !value)
        return fallback;
    const clean = value.replace(CONTROL_CHARS, " ").slice(0, maxLength);
    return clean || fallback;
}
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
    const workspaceCwd = input && typeof input.directory === "string" && input.directory.trim()
        ? input.directory
        : undefined;
    let configuredSessionKey;
    let configuredSessionId;
    let configuredCwd = workspaceCwd ?? process.cwd();
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
            const existing = isRecord(config.provider.qoder) ? config.provider.qoder : {};
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
            if (Date.now() - lastModelRefreshAt >= MODEL_REFRESH_INTERVAL_MS) {
                lastModelRefreshAt = Date.now();
                void fetchDynamicModels(true).catch((error) => {
                    debug("Background model refresh failed:", describeError(error));
                });
            }
            const existingModels = isRecord(existing.models) ? existing.models : {};
            const mergedModels = { ...builtinModels, ...existingModels };
            const bridgedMcp = bridgeMcpServers(config.mcp);
            const existingOptions = isRecord(existing.options) ? existing.options : {};
            const mergedOptions = { ...existingOptions };
            if (workspaceCwd && (typeof mergedOptions.cwd !== "string" || !mergedOptions.cwd.trim())) {
                mergedOptions.cwd = workspaceCwd;
            }
            if (typeof mergedOptions.cwd === "string" && mergedOptions.cwd.trim())
                configuredCwd = mergedOptions.cwd;
            configuredSessionKey = typeof mergedOptions.sessionKey === "string" ? mergedOptions.sessionKey : undefined;
            configuredSessionId = typeof mergedOptions.sessionId === "string" ? mergedOptions.sessionId : undefined;
            if (Object.keys(bridgedMcp).length > 0) {
                mergedOptions.mcpServers = {
                    ...(isRecord(existingOptions.mcpServers) ? existingOptions.mcpServers : {}),
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
                        if (!hasQoderCredential()) {
                            warn("Authorize failed: no usable Qoder credential found.", `Run qoder login or set ${QODER_PAT_ENV}, then retry.`);
                            return { type: "failed" };
                        }
                        return { type: "success", key: "qoder-cli-auth" };
                    },
                },
            ],
        },
        tool: {
            qoder_usage: tool({
                description: "Show Qoder account usage and quota (live), plus accumulated session cost and token totals from the local ledger.",
                args: {},
                async execute() {
                    try {
                        const lines = [];
                        const live = await getLiveUsage();
                        lines.push(live ? formatUsageReport(live) : "Live usage unavailable (not logged in or Qoder runtime unavailable).");
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
                    }
                    catch (error) {
                        return { title: "Qoder Usage", output: `Failed to load usage: ${describeError(error)}` };
                    }
                },
            }),
            qoder_models: tool({
                description: "List known Qoder models, capabilities, limits, and price multipliers.",
                args: {},
                async execute() {
                    const models = listModels();
                    const lines = ["Qoder Models"];
                    for (const model of models) {
                        lines.push(`  ${safeDisplay(model.id, "unknown", 256)}: ${safeDisplay(model.name, "unknown", 512)}`);
                        lines.push(`    context ${model.limit.context}, output ${model.limit.output}, price ${model.multiplier}x`);
                        lines.push(`    vision ${model.attachment ? "yes" : "no"}, reasoning ${model.reasoning ? "yes" : "no"}`);
                    }
                    return { title: "Qoder Models", output: lines.join("\n") };
                },
            }),
            qoder_session_reset: tool({
                description: "Forget the persisted Qoder session mapping for a key, or use 'all' to reset all sessions.",
                args: {
                    key: tool.schema.string().optional().describe("Session key to reset, or 'all' to clear all persisted sessions (defaults to configured sessionKey)."),
                },
                async execute(args) {
                    try {
                        const requested = typeof args.key === "string" ? args.key.trim() : "";
                        const target = requested || configuredSessionKey;
                        if (!target) {
                            return {
                                title: "Qoder Session",
                                output: "No session key specified and none configured. Provide a key or use 'all' to reset all sessions.",
                            };
                        }
                        if (target.toLowerCase() === "all") {
                            await clearAllSessions();
                            return { title: "Qoder Session", output: "Reset all persisted Qoder sessions." };
                        }
                        await deleteQoderSessionForCwd(target, configuredCwd, configuredSessionId || target);
                        return { title: "Qoder Session", output: `Reset persisted Qoder session: ${safeDisplay(target, "unknown", 512)}` };
                    }
                    catch (error) {
                        return { title: "Qoder Session", output: `Failed to reset session: ${describeError(error)}` };
                    }
                },
            }),
            qoder_sessions: tool({
                description: "List recent Qoder sessions with metadata (session ID, title, branch, last modified).",
                args: {
                    dir: tool.schema.string().optional().describe("Working directory / project path to filter sessions (optional)."),
                    limit: tool.schema.number().optional().describe("Maximum number of sessions to return (optional, default: 10)."),
                },
                async execute(args) {
                    try {
                        const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 10;
                        const dir = typeof args.dir === "string" && args.dir.trim() ? args.dir.trim() : undefined;
                        const sessionsResult = await listSessions({ limit: Math.max(1, Math.min(100, Math.floor(limit))), ...(dir ? { dir } : {}) });
                        const sessions = Array.isArray(sessionsResult) ? sessionsResult : [];
                        if (!sessions || sessions.length === 0) {
                            return { title: "Qoder Sessions", output: "No recent Qoder sessions found." };
                        }
                        const lines = ["Recent Qoder Sessions"];
                        for (const s of sessions) {
                            const item = isRecord(s) ? s : {};
                            const sessionId = safeDisplay(item.sessionId, "unknown", 256);
                            const title = typeof item.customTitle === "string" && item.customTitle
                                ? safeDisplay(item.customTitle, sessionId, 512)
                                : typeof item.summary === "string" && item.summary
                                    ? safeDisplay(item.summary, sessionId, 512)
                                    : sessionId;
                            const lastModified = item.lastModified;
                            const dateValue = typeof lastModified === "string" || typeof lastModified === "number"
                                ? new Date(lastModified)
                                : null;
                            const date = dateValue && !Number.isNaN(dateValue.getTime()) ? dateValue.toLocaleString() : "unknown";
                            const branch = safeDisplay(item.gitBranch, "n/a", 256);
                            const cwd = safeDisplay(item.cwd, "n/a", 1024);
                            lines.push(`• [${sessionId.slice(0, 8)}] ${title}`);
                            lines.push(`    Updated: ${date} | Branch: ${branch} | Path: ${cwd}`);
                        }
                        return { title: "Qoder Sessions", output: lines.join("\n") };
                    }
                    catch (error) {
                        debug("listSessions failed:", describeError(error));
                        return { title: "Qoder Sessions", output: `Failed to list sessions: ${describeError(error)}` };
                    }
                },
            }),
            qoder_plan_mode: tool({
                description: "Explain Qoder Plan Mode status and configuration in OpenCode.",
                args: {},
                async execute() {
                    const lines = [
                        "Qoder Plan Mode",
                        "Plan Mode instructs Qoder to analyze and plan changes without modifying files or running tool actions.",
                        "",
                        "Configuration in ~/.config/opencode/opencode.json:",
                        "  \"provider\": {",
                        "    \"qoder\": {",
                        "      \"options\": {",
                        "        \"planMode\": true",
                        "      }",
                        "    }",
                        "  }",
                        "",
                        "Plan Mode operates independently from tool permissions, preserving your underlying permission mode.",
                    ];
                    return { title: "Qoder Plan Mode", output: lines.join("\n") };
                },
            }),
        },
    };
};
export default plugin;
//# sourceMappingURL=index.js.map