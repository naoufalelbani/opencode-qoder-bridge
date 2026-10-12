import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import { createEffect, createSignal, Show } from "solid-js";
import { closeAllPendingMcpAuth, executeQoderCommand, QODER_COMMANDS, } from "./command-actions.js";
import { debug, describeError } from "./logger.js";
import { getLiveUsage } from "./usage.js";
import { mergedEnvironment } from "./environment.js";
import { formatCredits, formatQuota, formatSessionCredits, safeApiRead, shouldHideCommand } from "./tui.js";
const REFRESH_MS = 30_000;
const POST_TURN_REFRESH_MS = 5_000;
const MIN_REFRESH_GAP_MS = 5_000;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringOption(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
/** Resolved theme colors, tolerant of theme versions that keep a legacy shape. */
function color(theme, ...paths) {
    for (const path of paths) {
        let node = theme;
        for (const key of path) {
            if (node == null)
                break;
            node = node[key];
        }
        if (typeof node === "string" && node)
            return node;
    }
    return undefined;
}
function truncate(output) {
    return output.length > 50_000 ? `${output.slice(0, 50_000)}\n\n[Output truncated]` : output;
}
function usesQoder(ctx, sessionID) {
    if (!sessionID)
        return false;
    return safeApiRead(false, () => {
        const session = ctx.data.session.get(sessionID);
        if (session?.model)
            return session.model.providerID === "qoder";
        const messages = ctx.data.session.message.list(sessionID);
        const latest = messages.at(-1);
        if (!latest)
            return false;
        return latest.role === "user"
            ? latest.model?.providerID === "qoder"
            : latest.providerID === "qoder";
    });
}
function commandContext(ctx, pendingMcpAuth) {
    const options = { ...ctx.options };
    const environment = mergedEnvironment(isRecord(options.env)
        ? options.env
        : undefined);
    const modelOptions = {
        ...(stringOption(options.proxy) ? { proxy: stringOption(options.proxy) } : {}),
        ...(stringOption(options.vpcEndpoint) ? { vpcEndpoint: stringOption(options.vpcEndpoint) } : {}),
        ...(stringOption(options.cwd) ? { cwd: stringOption(options.cwd) } : {}),
    };
    const configuredCwd = stringOption(options.cwd) ?? ctx.location?.directory ?? process.cwd();
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
export const id = "opencode-qoder-bridge-sidebar";
/**
 * OpenCode 2's sidebar. OpenCode 1 keeps loading `tui.ts`; OpenCode 2 loads
 * `./tui` automatically and runs this `setup` through the V2 TUI contract.
 */
export const tui = {
    id,
    async setup(ctx) {
        const pendingMcpAuth = new Map();
        const context = commandContext(ctx, pendingMcpAuth);
        const showResult = async (result) => {
            const message = truncate(result.output);
            try {
                await ctx.ui.dialog.alert({ title: result.title, message });
            }
            catch (error) {
                debug("Could not open Qoder command dialog:", describeError(error));
                try {
                    ctx.ui.toast.show({
                        title: result.title,
                        message,
                        variant: result.variant ?? "info",
                        duration: 10_000,
                    });
                }
                catch (toastError) {
                    debug("Could not show Qoder command toast:", describeError(toastError));
                }
            }
        };
        const runCommand = async (name, rawArguments) => {
            try {
                ctx.ui.toast.show({ title: "Qoder", message: `Running /${name}…`, duration: 1_500 });
            }
            catch {
                // The result dialog is the durable display path; a toast is best effort.
            }
            try {
                await showResult(await executeQoderCommand(name, rawArguments, context));
            }
            catch (error) {
                await showResult({ title: "Qoder Command", output: `Command failed: ${describeError(error)}`, variant: "error" });
            }
        };
        ctx.keymap.layer(() => ({
            mode: "global",
            commands: QODER_COMMANDS.map((command) => ({
                id: command.name,
                title: command.title,
                description: command.description,
                group: "Qoder",
                palette: true,
                enabled: !shouldHideCommand(command, context),
                slash: { name: command.name, arguments: true },
                run: (input) => void runCommand(command.name, input ?? ""),
            })),
        }));
        const sessionBaselines = new Map();
        const [quota, setQuota] = createSignal({ error: "loading…", warning: false });
        const sessionCredits = (sessionID) => {
            return safeApiRead(undefined, () => {
                const used = quota().used;
                if (used == null)
                    return undefined;
                let baseline = sessionBaselines.get(sessionID);
                if (baseline == null || baseline > used) {
                    baseline = used;
                    sessionBaselines.set(sessionID, baseline);
                }
                return Math.max(0, used - baseline);
            });
        };
        let refreshing = false;
        let refreshedAt = 0;
        const refresh = async () => {
            if (refreshing || Date.now() - refreshedAt < MIN_REFRESH_GAP_MS)
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
        const timer = setInterval(() => {
            const route = ctx.ui.router.current();
            const sessionID = route?.type === "session" ? route.sessionID : undefined;
            if (sessionID && usesQoder(ctx, sessionID))
                void refresh();
        }, REFRESH_MS);
        let postTurnTimer;
        const stopIdleRefresh = ctx.data.on("session.idle", (event) => {
            if (!usesQoder(ctx, event?.properties?.sessionID))
                return;
            void refresh();
            clearTimeout(postTurnTimer);
            postTurnTimer = setTimeout(() => void refresh(), POST_TURN_REFRESH_MS);
        });
        const releaseSlot = ctx.ui.slot({
            append: "sidebar.content",
            render: ({ sessionID }) => {
                const isQoder = () => usesQoder(ctx, sessionID);
                createEffect(() => {
                    if (isQoder())
                        refreshIfNeeded();
                });
                return jsx(Show, {
                    get when() {
                        return isQoder();
                    },
                    get children() {
                        const base = ctx.theme;
                        const text = color(base, ["text", "base"], ["current", "text"]) ?? "#cdd6f4";
                        const muted = color(base, ["text", "muted"], ["current", "textMuted"]) ?? "#9399b2";
                        const warning = color(base, ["text", "warning"], ["current", "warning"]) ?? "#f9e2af";
                        return jsxs("box", {
                            flexDirection: "column",
                            marginTop: 1,
                            children: [
                                jsx("text", { fg: text, children: jsx("b", { children: "Qoder Credits" }) }),
                                jsx("text", {
                                    get fg() {
                                        return quota().warning ? warning : muted;
                                    },
                                    get children() {
                                        const accountDelta = sessionCredits(sessionID);
                                        const estimate = safeApiRead(0, () => ctx.data.session.cost(sessionID)) * 100;
                                        if (estimate > 0) {
                                            return `Session: ~${formatSessionCredits(estimate)} credits used`;
                                        }
                                        return accountDelta == null
                                            ? `Session: ${quota().error ?? "loading…"}`
                                            : `Session: ${formatSessionCredits(accountDelta)} credits used`;
                                    },
                                }),
                                jsx("text", {
                                    fg: muted,
                                    get children() {
                                        return `Spent: $${safeApiRead(0, () => ctx.data.session.cost(sessionID)).toFixed(4)}`;
                                    },
                                }),
                                jsx("text", {
                                    fg: muted,
                                    get children() {
                                        const current = quota();
                                        return current.used == null || current.total == null || current.remaining == null
                                            ? "Account quota unavailable"
                                            : current.warning && current.total === 0
                                                ? "Account: quota exhausted"
                                                : `Account: ${formatCredits(current.used)}/${formatCredits(current.total)} · ${formatCredits(current.remaining)} left`;
                                    },
                                }),
                            ],
                        });
                    },
                });
            },
        });
        return () => {
            releaseSlot();
            stopIdleRefresh();
            clearInterval(timer);
            clearTimeout(postTurnTimer);
            void closeAllPendingMcpAuth(pendingMcpAuth);
        };
    },
};
export default tui;
//# sourceMappingURL=tui-v2.js.map