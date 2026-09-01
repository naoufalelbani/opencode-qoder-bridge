import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import { createEffect, Show, createSignal } from "solid-js";
import { getLiveUsage } from "./usage.js";
import { debug, describeError } from "./logger.js";
import { closeAllPendingMcpAuth, executeQoderCommand, QODER_COMMANDS, } from "./command-actions.js";
import { bridgeMcpServers } from "./mcp-bridge.js";
const REFRESH_MS = 30_000;
const POST_TURN_REFRESH_MS = 5_000;
function formatCredits(value) {
    const safe = Number.isFinite(value) && value >= 0 ? value : 0;
    return Number.isInteger(safe)
        ? safe.toString()
        : safe.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
function formatSessionCredits(value) {
    return (Number.isFinite(value) && value >= 0 ? value : 0).toFixed(2);
}
function usesQoder(api, sessionID) {
    if (!sessionID)
        return false;
    const session = api.state.session.get(sessionID);
    if (session?.model)
        return session.model.providerID === "qoder";
    const messages = api.state.session.messages(sessionID);
    const latest = messages.at(-1);
    if (!latest)
        return false;
    return latest.role === "user"
        ? latest.model?.providerID === "qoder"
        : latest.providerID === "qoder";
}
function formatQuota(usage) {
    const quota = usage?.userQuota;
    if (!usage || !quota || typeof quota.total !== "number" || !Number.isFinite(quota.total) || quota.total < 0) {
        return {
            error: "usage unavailable",
            warning: true,
        };
    }
    const total = quota.total;
    const used = Math.min(total, Math.max(0, typeof quota.used === "number" && Number.isFinite(quota.used)
        ? quota.used
        : total - (typeof quota.remaining === "number" && Number.isFinite(quota.remaining) ? quota.remaining : total)));
    const remaining = Math.max(0, total - used);
    const percentValue = typeof quota.percentage === "number" && Number.isFinite(quota.percentage)
        ? quota.percentage
        : typeof usage.totalUsagePercentage === "number" && Number.isFinite(usage.totalUsagePercentage)
            ? usage.totalUsagePercentage
            : total > 0 ? (used / total) * 100 : 0;
    const percent = Math.min(100, Math.max(0, percentValue));
    return {
        used,
        total,
        remaining,
        percent,
        warning: usage.isQuotaExceeded === true || remaining <= Math.max(10, total * 0.1),
    };
}
function sessionSpent(api, sessionID) {
    if (!sessionID)
        return 0;
    const sessionCost = api.state.session.get(sessionID)?.cost;
    if (typeof sessionCost === "number" && Number.isFinite(sessionCost))
        return sessionCost;
    return api.state.session
        .messages(sessionID)
        .reduce((total, message) => {
        if (message.role === "assistant" && typeof message.cost === "number" && Number.isFinite(message.cost)) {
            const next = total + message.cost;
            return Number.isFinite(next) ? next : Number.MAX_SAFE_INTEGER;
        }
        return total;
    }, 0);
}
function estimatedSessionCredits(api, sessionID) {
    // Qoder's Credits Log presents reference cost in dollars and Credits in
    // cent-denominated units. The personal-account SDK exposes only a rounded
    // whole-account quota, so session.cost * 100 is the best fractional signal
    // available until the SDK exposes per-request credit events.
    const estimate = sessionSpent(api, sessionID) * 100;
    return Number.isFinite(estimate) ? estimate : Number.MAX_SAFE_INTEGER;
}
export const id = "opencode-qoder-bridge-sidebar";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringOption(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function hasEntries(value) {
    return isRecord(value) && Object.keys(value).length > 0;
}
/**
 * Keep every command registered so direct dispatch and the tool surface stay
 * intact, but hide commands whose prerequisites are not present from the
 * OpenCode command palette. `hidden` is intentionally separate from
 * `enabled`: hidden commands are not disabled.
 */
function shouldHideCommand(command, context) {
    const options = isRecord(context.configuredBridgeOptions)
        ? context.configuredBridgeOptions
        : {};
    switch (command.name) {
        case "qoder_usage":
        case "qoder_models":
            return false;
        case "qoder_sessions":
        case "qoder_session_reset":
        case "qoder_session_fork":
            return !(options.sessionPersistence === true
                || stringOption(options.sessionKey) !== undefined
                || stringOption(options.sessionId) !== undefined);
        case "qoder_mcp_status":
        case "qoder_mcp_auth":
            return !hasEntries(options.mcpServers);
        case "qoder_plan_mode":
            return true;
    }
}
function commandContext(api, pendingMcpAuth) {
    const config = isRecord(api.state.config) ? api.state.config : {};
    const provider = isRecord(config.provider) ? config.provider : {};
    const qoder = isRecord(provider.qoder) ? provider.qoder : {};
    const sourceOptions = isRecord(qoder.options) ? qoder.options : {};
    const options = { ...sourceOptions };
    if (!isRecord(options.mcpServers)) {
        const bridgedMcp = bridgeMcpServers(config.mcp);
        if (Object.keys(bridgedMcp).length > 0)
            options.mcpServers = bridgedMcp;
    }
    const environment = { ...process.env };
    if (isRecord(options.env)) {
        for (const [key, value] of Object.entries(options.env)) {
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && (typeof value === "string" || value === undefined)) {
                environment[key] = value;
            }
        }
    }
    const modelOptions = {
        ...(stringOption(options.proxy) ? { proxy: stringOption(options.proxy) } : {}),
        ...(stringOption(options.vpcEndpoint) ? { vpcEndpoint: stringOption(options.vpcEndpoint) } : {}),
        ...(stringOption(options.cwd) ? { cwd: stringOption(options.cwd) } : {}),
    };
    const configuredCwd = stringOption(options.cwd) ?? stringOption(api.state.path.directory) ?? process.cwd();
    return {
        configuredCwd,
        ...(stringOption(options.sessionKey) ? { configuredSessionKey: stringOption(options.sessionKey) } : {}),
        ...(stringOption(options.sessionId) ? { configuredSessionId: stringOption(options.sessionId) } : {}),
        configuredBridgeOptions: options,
        modelEnvironment: environment,
        modelOptions,
        pendingMcpAuth,
    };
}
function showCommandResult(api, result, dialog) {
    const target = dialog ?? api.ui.dialog;
    const message = result.output.length > 50_000
        ? `${result.output.slice(0, 50_000)}\n\n[Output truncated]`
        : result.output;
    try {
        target.replace(() => api.ui.DialogAlert({
            title: result.title,
            message,
            onConfirm: () => target.clear(),
        }));
    }
    catch (error) {
        debug("Could not open Qoder command result dialog:", describeError(error));
        try {
            api.ui.toast({
                title: result.title,
                message,
                variant: result.variant ?? "info",
                duration: 10_000,
            });
        }
        catch (toastError) {
            debug("Could not show Qoder command result toast:", describeError(toastError));
        }
    }
}
function showCommandError(api, error, dialog) {
    showCommandResult(api, {
        title: "Qoder Command",
        output: `Command failed: ${describeError(error)}`,
        variant: "error",
    }, dialog);
}
function runDisplayCommand(api, context, name, rawArguments, dialog) {
    try {
        api.ui.toast({ title: "Qoder", message: `Running /${name}…`, duration: 1_500 });
    }
    catch {
        // The result dialog is the durable display path; a toast is best effort.
    }
    void executeQoderCommand(name, rawArguments, context)
        .then((result) => showCommandResult(api, result, dialog))
        .catch((error) => showCommandError(api, error, dialog));
}
function openArgumentDialog(api, context, command, dialog) {
    const target = dialog ?? api.ui.dialog;
    target.replace(() => api.ui.DialogPrompt({
        title: `${command.title} arguments`,
        placeholder: command.argumentHint,
        onConfirm: (value) => runDisplayCommand(api, context, command.name, value, target),
        onCancel: () => target.clear(),
    }));
}
export function registerInstantCommands(api, context) {
    const run = (command, dialog) => {
        if (command.argumentHint) {
            openArgumentDialog(api, context, command, dialog);
            return;
        }
        runDisplayCommand(api, context, command.name, "", dialog);
    };
    const keymap = api.keymap;
    if (typeof keymap.registerLayer === "function") {
        try {
            const disposer = keymap.registerLayer({
                commands: QODER_COMMANDS.map((command) => ({
                    namespace: "palette",
                    name: `qoder.${command.name}`,
                    title: command.title,
                    category: "Qoder",
                    desc: command.description,
                    hidden: shouldHideCommand(command, context),
                    slashName: command.name,
                    run: () => run(command),
                })),
            });
            if (typeof disposer === "function")
                api.lifecycle.onDispose(disposer);
            return;
        }
        catch (error) {
            debug("Could not register Qoder keymap commands; trying legacy registration:", describeError(error));
        }
    }
    if (api.command?.register) {
        const disposer = api.command.register(() => QODER_COMMANDS.map((command) => ({
            title: command.title,
            value: `qoder.${command.name}`,
            category: "Qoder",
            description: command.description,
            hidden: shouldHideCommand(command, context),
            slash: { name: command.name },
            onSelect: (dialog) => run(command, dialog),
        })));
        api.lifecycle.onDispose(disposer);
        return;
    }
    try {
        api.ui.toast({
            title: "Qoder",
            message: "OpenCode did not expose a TUI command registry; Qoder commands are unavailable.",
            variant: "warning",
            duration: 10_000,
        });
    }
    catch (error) {
        debug("Could not report missing Qoder TUI command registry:", describeError(error));
    }
}
export const tui = async (api) => {
    const pendingMcpAuth = new Map();
    const context = commandContext(api, pendingMcpAuth);
    registerInstantCommands(api, context);
    api.lifecycle.onDispose(() => closeAllPendingMcpAuth(pendingMcpAuth));
    const [quota, setQuota] = createSignal({
        error: "loading…",
        warning: false,
    });
    const sessionBaselines = new Map();
    const sessionCredits = (sessionID) => {
        const used = quota().used;
        if (used == null)
            return undefined;
        const key = `opencode-qoder-bridge:credit-baseline:${sessionID}`;
        let baseline = sessionBaselines.get(sessionID);
        if (baseline == null) {
            baseline = api.kv.get(key, undefined);
            if (baseline == null || baseline > used) {
                baseline = used;
                api.kv.set(key, baseline);
            }
            sessionBaselines.set(sessionID, baseline);
        }
        return Math.max(0, used - baseline);
    };
    let refreshing = false;
    let refreshedAt = 0;
    const refresh = async () => {
        if (refreshing)
            return;
        refreshing = true;
        try {
            setQuota(formatQuota(await getLiveUsage(true)));
            refreshedAt = Date.now();
        }
        catch (error) {
            refreshedAt = Date.now();
            setQuota({ error: "usage unavailable", warning: true });
            debug("TUI quota refresh failed:", describeError(error));
        }
        finally {
            refreshing = false;
        }
    };
    const refreshIfNeeded = () => {
        if (Date.now() - refreshedAt >= REFRESH_MS)
            void refresh();
    };
    const activeSessionUsesQoder = () => {
        const route = api.route.current;
        const sessionID = route.name === "session" &&
            route.params &&
            typeof route.params.sessionID === "string"
            ? route.params.sessionID
            : undefined;
        return sessionID ? usesQoder(api, sessionID) : false;
    };
    const timer = setInterval(() => {
        if (activeSessionUsesQoder())
            void refresh();
    }, REFRESH_MS);
    let postTurnTimer;
    const stopIdleRefresh = api.event.on("session.idle", (event) => {
        if (!usesQoder(api, event?.properties?.sessionID))
            return;
        void refresh();
        clearTimeout(postTurnTimer);
        postTurnTimer = setTimeout(() => void refresh(), POST_TURN_REFRESH_MS);
    });
    api.lifecycle.onDispose(() => {
        clearInterval(timer);
        clearTimeout(postTurnTimer);
        sessionBaselines.clear();
        stopIdleRefresh();
    });
    api.slots.register({
        order: 50,
        slots: {
            sidebar_content: ({ theme }, { session_id }) => {
                const isQoder = () => usesQoder(api, session_id);
                createEffect(() => {
                    if (isQoder())
                        refreshIfNeeded();
                });
                return jsx(Show, {
                    get when() {
                        return isQoder();
                    },
                    get children() {
                        return jsxs("box", {
                            flexDirection: "column",
                            marginTop: 1,
                            children: [
                                jsx("text", {
                                    fg: theme.current.text,
                                    children: jsx("b", { children: "Qoder Credits" }),
                                }),
                                jsx("text", {
                                    get fg() {
                                        return quota().warning ? theme.current.warning : theme.current.textMuted;
                                    },
                                    get children() {
                                        const accountDelta = sessionCredits(session_id);
                                        const estimate = estimatedSessionCredits(api, session_id);
                                        if (estimate > 0) {
                                            return `Session: ~${formatSessionCredits(estimate)} credits used`;
                                        }
                                        return accountDelta == null
                                            ? `Session: ${quota().error ?? "loading…"}`
                                            : `Session: ${formatSessionCredits(accountDelta)} credits used`;
                                    },
                                }),
                                jsx("text", {
                                    fg: theme.current.textMuted,
                                    get children() {
                                        return `Spent: $${sessionSpent(api, session_id).toFixed(4)}`;
                                    },
                                }),
                                jsx("text", {
                                    fg: theme.current.textMuted,
                                    get children() {
                                        const current = quota();
                                        return current.used == null || current.total == null || current.remaining == null
                                            ? "Account quota unavailable"
                                            : `Account: ${formatCredits(current.used)}/${formatCredits(current.total)} · ${formatCredits(current.remaining)} left`;
                                    },
                                }),
                            ],
                        });
                    },
                });
            },
        },
    });
};
export default { id, tui };
//# sourceMappingURL=tui.js.map