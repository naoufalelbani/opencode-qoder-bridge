import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import { createEffect, Show, createSignal } from "solid-js";
import { getLiveUsage } from "./usage.js";

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
  return Number.isInteger(value)
    ? value.toString()
    : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatSessionCredits(value: number): string {
  return value.toFixed(2);
}

function usesQoder(api: Parameters<TuiPlugin>[0], sessionID: string): boolean {
  const session = api.state.session.get(sessionID);
  if (session?.model) return session.model.providerID === "qoder";

  const messages = api.state.session.messages(sessionID);
  const latest = messages.at(-1);
  if (!latest) return false;

  return latest.role === "user"
    ? latest.model.providerID === "qoder"
    : latest.providerID === "qoder";
}

function formatQuota(usage: Awaited<ReturnType<typeof getLiveUsage>>): QuotaView {
  const quota = usage?.userQuota;
  if (!usage || !quota || quota.total == null) {
    return {
      error: "usage unavailable",
      warning: true,
    };
  }

  const used = quota.used ?? Math.max(0, quota.total - (quota.remaining ?? quota.total));
  const remaining = quota.remaining ?? Math.max(0, quota.total - used);
  const percent =
    quota.percentage ??
    usage.totalUsagePercentage ??
    (quota.total > 0 ? (used / quota.total) * 100 : 0);

  return {
    used,
    total: quota.total,
    remaining,
    percent,
    warning: usage.isQuotaExceeded === true || remaining <= Math.max(10, quota.total * 0.1),
  };
}

function sessionSpent(api: Parameters<TuiPlugin>[0], sessionID: string): number {
  const sessionCost = api.state.session.get(sessionID)?.cost;
  if (typeof sessionCost === "number") return sessionCost;

  return api.state.session
    .messages(sessionID)
    .reduce((total, message) => total + (message.role === "assistant" ? message.cost : 0), 0);
}

function estimatedSessionCredits(api: Parameters<TuiPlugin>[0], sessionID: string): number {
  // Qoder's Credits Log presents reference cost in dollars and Credits in
  // cent-denominated units. The personal-account SDK exposes only a rounded
  // whole-account quota, so session.cost * 100 is the best fractional signal
  // available until the SDK exposes per-request credit events.
  return sessionSpent(api, sessionID) * 100;
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
    if (!usesQoder(api, event.properties.sessionID)) return;

    void refresh();
    clearTimeout(postTurnTimer);
    postTurnTimer = setTimeout(() => void refresh(), POST_TURN_REFRESH_MS);
  });
  api.lifecycle.onDispose(() => {
    clearInterval(timer);
    clearTimeout(postTurnTimer);
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
