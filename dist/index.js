import { tool } from "@opencode-ai/plugin";
import { forkSession, listSessions } from "@qoder-ai/qoder-agent-sdk";
import { FALLBACK_MODELS, fetchDynamicModels, getCachedDynamicModels, listModels } from "./models.js";
import { hasQoderCredential, QODER_PAT_ENV } from "./sdk-auth.js";
import { bridgeMcpServers } from "./mcp-bridge.js";
import { getLiveUsage, formatUsageReport } from "./usage.js";
import { summarize, formatCost } from "./cost.js";
import { ensureTuiRegistered } from "./tui-register.js";
import { clearAllSessions, deleteQoderSessionForCwd, getQoderSessionForCwd } from "./session-store.js";
import { debug, describeError, isDebugEnabled, warn } from "./logger.js";
import { formatMcpStatuses, openSdkControlSession, withMcpControlTimeout } from "./sdk-control.js";
const PROVIDER_URL = new URL("./provider.js", import.meta.url).href;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MODEL_STARTUP_DISCOVERY_TIMEOUT_MS = 10_000;
const MCP_AUTH_TTL_MS = 10 * 60 * 1000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROL_CHAR_TEST = /[\u0000-\u001f\u007f-\u009f]/;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeDisplay(value, fallback, maxLength = 512) {
    if (typeof value !== "string" || !value)
        return fallback;
    const clean = value.replace(CONTROL_CHARS, " ").slice(0, maxLength);
    return clean || fallback;
}
function discoveryEnvironment(value) {
    const environment = { ...process.env };
    if (!isRecord(value))
        return environment;
    for (const [key, item] of Object.entries(value)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            continue;
        if (typeof item === "string" || item === undefined)
            environment[key] = item;
    }
    return environment;
}
function discoveryOptions(options) {
    const result = { timeoutMs: MODEL_STARTUP_DISCOVERY_TIMEOUT_MS };
    if (typeof options.proxy === "string" && options.proxy.trim())
        result.proxy = options.proxy;
    if (typeof options.vpcEndpoint === "string" && options.vpcEndpoint.trim())
        result.vpcEndpoint = options.vpcEndpoint;
    if (typeof options.cwd === "string" && options.cwd.trim())
        result.cwd = options.cwd;
    return result;
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
    let configuredBridgeOptions = {};
    let modelEnvironment = { ...process.env };
    let modelOptions = { timeoutMs: MODEL_STARTUP_DISCOVERY_TIMEOUT_MS };
    const pendingMcpAuth = new Map();
    const closePendingMcpAuth = async (serverName) => {
        const pending = pendingMcpAuth.get(serverName);
        if (!pending)
            return;
        pendingMcpAuth.delete(serverName);
        clearTimeout(pending.timer);
        await pending.close();
    };
    const savePendingMcpAuth = async (serverName, session) => {
        await closePendingMcpAuth(serverName);
        const pending = {
            query: session.query,
            close: session.close,
            timer: undefined,
        };
        const timer = setTimeout(() => {
            if (pendingMcpAuth.get(serverName) !== pending)
                return;
            pendingMcpAuth.delete(serverName);
            void pending.close().catch((error) => {
                debug("Could not close expired MCP auth session:", describeError(error));
            });
        }, MCP_AUTH_TTL_MS);
        if (typeof timer.unref === "function")
            timer.unref();
        pending.timer = timer;
        pendingMcpAuth.set(serverName, pending);
    };
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
            const existingOptions = isRecord(existing.options) ? existing.options : {};
            const environment = discoveryEnvironment(existingOptions.env);
            const discoveryConfig = discoveryOptions(existingOptions);
            modelEnvironment = environment;
            modelOptions = discoveryConfig;
            // OpenCode snapshots provider models while this hook runs. Complete one
            // bounded live discovery before returning so a fresh install exposes the
            // current account catalog immediately; retain cache/fallback behavior if
            // Qoder is offline, unauthenticated, or slower than the startup budget.
            let dynamic = getCachedDynamicModels(environment, discoveryConfig);
            try {
                const refreshed = await fetchDynamicModels(true, environment, discoveryConfig);
                if (refreshed)
                    dynamic = refreshed;
            }
            catch (error) {
                debug("Startup model discovery unavailable; using cached/fallback models:", describeError(error));
            }
            const builtinModels = {};
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
            const existingModels = isRecord(existing.models) ? existing.models : {};
            const mergedModels = { ...builtinModels, ...existingModels };
            const bridgedMcp = bridgeMcpServers(config.mcp);
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
            configuredBridgeOptions = mergedOptions;
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
                    const models = listModels(modelEnvironment, modelOptions);
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
            qoder_session_fork: tool({
                description: "Fork a persisted Qoder session into a new independent session without changing the active session mapping.",
                args: {
                    sessionId: tool.schema.string().optional().describe("Source Qoder session ID (defaults to the configured/resumed session)."),
                    dir: tool.schema.string().optional().describe("Working directory containing the session transcript (optional, defaults to the active project)."),
                    title: tool.schema.string().optional().describe("Optional title for the fork."),
                    upToMessageId: tool.schema.string().optional().describe("Optional transcript message UUID; fork only the history through this message."),
                },
                async execute(args) {
                    try {
                        const requestedId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
                        const dir = typeof args.dir === "string" && args.dir.trim() ? args.dir.trim() : configuredCwd;
                        let sourceId = requestedId || configuredSessionId;
                        if (!sourceId && configuredSessionKey) {
                            const persisted = await getQoderSessionForCwd(configuredSessionKey, dir);
                            sourceId = persisted?.qoderSessionId;
                        }
                        if (!sourceId) {
                            return {
                                title: "Qoder Session Fork",
                                output: "No source session ID is available. Provide sessionId or configure session persistence first.",
                            };
                        }
                        const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
                        const upToMessageId = typeof args.upToMessageId === "string" && args.upToMessageId.trim()
                            ? args.upToMessageId.trim()
                            : undefined;
                        const forked = await forkSession(sourceId, {
                            dir,
                            ...(title ? { title } : {}),
                            ...(upToMessageId ? { upToMessageId } : {}),
                        });
                        return {
                            title: "Qoder Session Fork",
                            output: [
                                `Forked session ${safeDisplay(sourceId, "unknown", 256)}.`,
                                `New session ID: ${safeDisplay(forked.sessionId, "unknown", 256)}`,
                                "The active provider mapping was left unchanged; use the new ID as sessionId when you want to continue the fork.",
                            ].join("\n"),
                        };
                    }
                    catch (error) {
                        return { title: "Qoder Session Fork", output: `Failed to fork session: ${describeError(error)}` };
                    }
                },
            }),
            qoder_mcp_status: tool({
                description: "Inspect Qoder MCP server connection and OAuth status without sending a model turn.",
                args: {},
                async execute() {
                    let control;
                    try {
                        control = await openSdkControlSession(configuredBridgeOptions, configuredCwd);
                        const statuses = await withMcpControlTimeout(control.query.mcpServerStatus(), "status request");
                        return { title: "Qoder MCP Status", output: formatMcpStatuses(statuses) };
                    }
                    catch (error) {
                        return { title: "Qoder MCP Status", output: `Failed to inspect MCP status: ${describeError(error)}` };
                    }
                    finally {
                        if (control)
                            await control.close();
                    }
                },
            }),
            qoder_mcp_auth: tool({
                description: "Start or complete OAuth authentication for a configured Qoder MCP server.",
                args: {
                    server: tool.schema.string().describe("Configured MCP server name."),
                    callbackUrl: tool.schema.string().optional().describe("OAuth callback URL copied after authorizing (omit to start the flow)."),
                    redirectUri: tool.schema.string().optional().describe("Optional redirect URI to use when starting OAuth."),
                },
                async execute(args) {
                    const serverName = typeof args.server === "string" ? args.server.trim() : "";
                    const callbackUrl = typeof args.callbackUrl === "string" ? args.callbackUrl.trim() : "";
                    const redirectUri = typeof args.redirectUri === "string" ? args.redirectUri.trim() : "";
                    if (!serverName || serverName.length > 256 || CONTROL_CHAR_TEST.test(serverName)) {
                        return { title: "Qoder MCP OAuth", output: "Provide a valid MCP server name." };
                    }
                    if (callbackUrl && (callbackUrl.length > 16_384 || CONTROL_CHAR_TEST.test(callbackUrl))) {
                        return { title: "Qoder MCP OAuth", output: "The callback URL is invalid or too long." };
                    }
                    if (redirectUri && (redirectUri.length > 16_384 || CONTROL_CHAR_TEST.test(redirectUri))) {
                        return { title: "Qoder MCP OAuth", output: "The redirect URI is invalid or too long." };
                    }
                    const pending = pendingMcpAuth.get(serverName);
                    if (callbackUrl && !pending) {
                        return {
                            title: "Qoder MCP OAuth",
                            output: `No pending OAuth flow for ${safeDisplay(serverName, "unknown")}. Call qoder_mcp_auth without callbackUrl first, then authorize using the returned URL.`,
                        };
                    }
                    if (callbackUrl && pending) {
                        try {
                            await withMcpControlTimeout(pending.query.mcpSubmitOAuthCallbackUrl(serverName, callbackUrl), "OAuth callback");
                            pendingMcpAuth.delete(serverName);
                            clearTimeout(pending.timer);
                            await pending.close();
                            return {
                                title: "Qoder MCP OAuth",
                                output: `OAuth authentication completed for ${safeDisplay(serverName, "unknown")}. Run qoder_mcp_status to verify the connection.`,
                            };
                        }
                        catch (error) {
                            return {
                                title: "Qoder MCP OAuth",
                                output: `OAuth callback failed: ${describeError(error)} The pending flow was retained for another callback attempt.`,
                            };
                        }
                    }
                    await closePendingMcpAuth(serverName);
                    let control;
                    try {
                        control = await openSdkControlSession(configuredBridgeOptions, configuredCwd);
                        const result = await withMcpControlTimeout(control.query.mcpAuthenticate(serverName, redirectUri || undefined), "OAuth authentication");
                        if (!result.requiresUserAction) {
                            await control.close();
                            control = undefined;
                            return {
                                title: "Qoder MCP OAuth",
                                output: `${safeDisplay(serverName, "unknown")} is already authenticated (or was refreshed silently).`,
                            };
                        }
                        if (!result.authUrl) {
                            await control.close();
                            control = undefined;
                            return {
                                title: "Qoder MCP OAuth",
                                output: `Qoder requires user action for ${safeDisplay(serverName, "unknown")}, but did not return an authorization URL.`,
                            };
                        }
                        await savePendingMcpAuth(serverName, control);
                        control = undefined;
                        return {
                            title: "Qoder MCP OAuth",
                            output: [
                                `Authorize ${safeDisplay(serverName, "unknown")} by opening this URL:`,
                                safeDisplay(result.authUrl, "(authorization URL unavailable)", 16_384),
                                "After the redirect, call qoder_mcp_auth again with the same server and the complete callbackUrl.",
                                `The pending flow expires in ${Math.round(MCP_AUTH_TTL_MS / 60_000)} minutes.`,
                            ].join("\n"),
                        };
                    }
                    catch (error) {
                        return { title: "Qoder MCP OAuth", output: `Failed to start OAuth: ${describeError(error)}` };
                    }
                    finally {
                        if (control)
                            await control.close();
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