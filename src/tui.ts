import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import { createEffect, Show, createSignal } from "solid-js";
import { getLiveUsage } from "./usage.js";
import { debug, describeError } from "./logger.js";

const REFRESH_MS = 30_000;
const POST_TURN_REFRESH_MS = 5_000;

type QuotaView = {
  used?: number;
  total?: number;
  remaining?: number;
  percent?: number;
  error?: string;
  warning: boolean;
};

function formatCredits(value: number): string {
  const safe = Number.isFinite(value) && value >= 0 ? value : 0;
  return Number.isInteger(safe)
    ? safe.toString()
    : safe.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatSessionCredits(value: number): string {
  return (Number.isFinite(value) && value >= 0 ? value : 0).toFixed(2);
}

function usesQoder(api: Parameters<TuiPlugin>[0], sessionID: string | undefined): boolean {
  if (!sessionID) return false;
  const session = api.state.session.get(sessionID);
  if (session?.model) return session.model.providerID === "qoder";

  const messages = api.state.session.messages(sessionID);
  const latest = messages.at(-1);
  if (!latest) return false;

  return latest.role === "user"
    ? latest.model?.providerID === "qoder"
    : latest.providerID === "qoder";
}

function formatQuota(usage: Awaited<ReturnType<typeof getLiveUsage>>): QuotaView {
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

function sessionSpent(api: Parameters<TuiPlugin>[0], sessionID: string): number {
  if (!sessionID) return 0;
  const sessionCost = api.state.session.get(sessionID)?.cost;
  if (typeof sessionCost === "number" && Number.isFinite(sessionCost)) return sessionCost;

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

function estimatedSessionCredits(api: Parameters<TuiPlugin>[0], sessionID: string): number {
  // Qoder's Credits Log presents reference cost in dollars and Credits in
  // cent-denominated units. The personal-account SDK exposes only a rounded
  // whole-account quota, so session.cost * 100 is the best fractional signal
  // available until the SDK exposes per-request credit events.
  const estimate = sessionSpent(api, sessionID) * 100;
  return Number.isFinite(estimate) ? estimate : Number.MAX_SAFE_INTEGER;
}

export const id = "opencode-qoder-bridge-sidebar";

export const tui: TuiPlugin = async (api) => {
  const [quota, setQuota] = createSignal<QuotaView>({
    error: "loading…",
    warning: false,
  });
  const sessionBaselines = new Map<string, number>();

  const sessionCredits = (sessionID: string): number | undefined => {
    const used = quota().used;
    if (used == null) return undefined;

    const key = `opencode-qoder-bridge:credit-baseline:${sessionID}`;
    let baseline = sessionBaselines.get(sessionID);
    if (baseline == null) {
      baseline = api.kv.get<number | undefined>(key, undefined);
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
    if (refreshing) return;
    refreshing = true;
    try {
      setQuota(formatQuota(await getLiveUsage(true)));
      refreshedAt = Date.now();
    } catch (error) {
      refreshedAt = Date.now();
      setQuota({ error: "usage unavailable", warning: true });
      debug("TUI quota refresh failed:", describeError(error));
    } finally {
      refreshing = false;
    }
  };

  const refreshIfNeeded = () => {
    if (Date.now() - refreshedAt >= REFRESH_MS) void refresh();
  };

  const activeSessionUsesQoder = () => {
    const route = api.route.current;
    const sessionID =
      route.name === "session" &&
      route.params &&
      typeof route.params.sessionID === "string"
        ? route.params.sessionID
        : undefined;
    return sessionID ? usesQoder(api, sessionID) : false;
  };

  const timer = setInterval(() => {
    if (activeSessionUsesQoder()) void refresh();
  }, REFRESH_MS);
  let postTurnTimer: ReturnType<typeof setTimeout> | undefined;
  const stopIdleRefresh = api.event.on("session.idle", (event) => {
    if (!usesQoder(api, event?.properties?.sessionID)) return;

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
          if (isQoder()) refreshIfNeeded();
        });

        return jsx(Show as any, {
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

export default { id, tui } satisfies TuiPluginModule;
