import { accessToken, accessTokenFromEnv, jobToken, qodercliAuth } from "@qoder-ai/qoder-agent-sdk";
import type { Options } from "@qoder-ai/qoder-agent-sdk";
import { isAuthenticated } from "./auth.js";
import { refreshQoderJobToken } from "./device-sign-in.js";
import { QoderAuthError } from "./errors.js";
import { readStoredBrowserCredential, writeStoredBrowserCredential } from "./opencode-auth-store.js";

export const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN";
export const QODER_AUTH_MODE_ENV = "QODER_AUTH_MODE";
const REFRESH_LEAD_MS = 5 * 60_000;

export interface BrowserCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export interface BrowserAuthSource {
  accountId?: string;
  storeBacked?: boolean;
  read: () => Promise<BrowserCredential | null>;
  write: (credential: BrowserCredential, previous: BrowserCredential) => Promise<void>;
}

let browserSource: BrowserAuthSource | null = null;
let refreshInFlight: Promise<BrowserCredential> | null = null;
const issuedTokens = new Map<string, string>();

/** OpenCode owns the saved OAuth credential; the bridge only holds accessors. */
export function configureBrowserAuth(source: BrowserAuthSource | null): void {
  if (browserSource?.accountId !== source?.accountId) {
    refreshInFlight = null;
    issuedTokens.clear();
  }
  browserSource = source;
  if (!source) {
    refreshInFlight = null;
    issuedTokens.clear();
  }
}

function ensureBrowserSource(environment: Record<string, string | undefined>): void {
  if (browserSource && !browserSource.storeBacked) return;
  if (environment.OPENCODE_AUTH_CONTENT) {
    if (browserSource?.storeBacked) configureBrowserAuth(null);
    return;
  }
  const saved = readStoredBrowserCredential(environment);
  if (!saved) {
    if (browserSource?.storeBacked) configureBrowserAuth(null);
    return;
  }
  if (browserSource?.storeBacked && browserSource.accountId === saved.accountId) return;
  configureBrowserAuth({
    accountId: saved.accountId,
    storeBacked: true,
    read: async () => readStoredBrowserCredential(environment),
    write: (updated, previous) => writeStoredBrowserCredential(updated, previous, environment),
  });
}

export function browserAuthIdentity(environment: Record<string, string | undefined> = process.env): string | undefined {
  ensureBrowserSource(environment);
  return browserSource ? browserSource.accountId ?? "browser-account" : undefined;
}

function rememberIssued(requestId: string, token: string): void {
  if (!requestId) return;
  issuedTokens.set(requestId, token);
  if (issuedTokens.size > 512) issuedTokens.delete(issuedTokens.keys().next().value!);
}

async function currentJobToken(requestId: string, reason: string, signal: AbortSignal) {
  const source = browserSource;
  if (!source) return null;
  const current = await source.read();
  if (!current || !current.access.trim()) return null;

  const issued = issuedTokens.get(requestId);
  const renewedElsewhere = issued !== undefined && current.access !== issued;
  const needsRefresh = current.expires <= Date.now() + REFRESH_LEAD_MS
    || (reason === "unauthorized" && !renewedElsewhere);
  if (!needsRefresh) {
    rememberIssued(requestId, current.access);
    return { token: current.access, expiresAt: current.expires };
  }

  if (!refreshInFlight) {
    const operation = (async () => {
      const latest = await source.read();
      if (!latest || !latest.refresh.trim()) throw new QoderAuthError("Qoder browser sign-in has expired; sign in again.");
      if (latest.access !== current.access && latest.expires > Date.now() + REFRESH_LEAD_MS) return latest;
      const renewed = await refreshQoderJobToken(latest.refresh, signal);
      const updated: BrowserCredential = { ...latest, ...renewed, type: "oauth" };
      try {
        await source.write(updated, latest);
      } catch (error) {
        const changed = await source.read();
        if (changed?.access !== latest.access && changed && changed.expires > Date.now() + REFRESH_LEAD_MS) return changed;
        throw error;
      }
      return updated;
    })();
    refreshInFlight = operation;
    operation.then(
      () => { if (refreshInFlight === operation) refreshInFlight = null; },
      () => { if (refreshInFlight === operation) refreshInFlight = null; },
    );
  }
  const refreshed = await refreshInFlight;
  rememberIssued(requestId, refreshed.access);
  return { token: refreshed.access, expiresAt: refreshed.expires };
}

export function hasQoderPAT(environment: Record<string, string | undefined> = process.env): boolean {
  return Boolean(environment[QODER_PAT_ENV]?.trim());
}

/** PAT, CLI login, and browser sign-in all drive the same SDK runtime. */
export function qoderAuth(environment: Record<string, string | undefined> = process.env): Options["auth"] {
  ensureBrowserSource(environment);
  const token = environment[QODER_PAT_ENV];
  if (token?.trim()) {
    // Keep the SDK's env-backed auth shape for normal values, but avoid sending
    // accidental surrounding whitespace when a caller configured a token that
    // was copied from a shell or secret store.
    return token === token.trim() ? accessTokenFromEnv(QODER_PAT_ENV) : accessToken(token.trim());
  }
  const mode = environment[QODER_AUTH_MODE_ENV]?.trim().toLowerCase();
  // The installed Qoder CLI is the fastest known path on machines already
  // logged in with it. Browser auth remains the fallback and can be selected
  // explicitly when the two sign-ins belong to different accounts.
  if (environment.QODER_REGION === "cn" || mode === "cli" || (mode !== "browser" && isAuthenticated())) {
    return qodercliAuth();
  }
  if (browserSource) {
    return jobToken((request, options) => currentJobToken(request.requestId, request.reason, options.signal));
  }
  return qodercliAuth();
}

export function hasQoderCredential(environment: Record<string, string | undefined> = process.env): boolean {
  ensureBrowserSource(environment);
  if (hasQoderPAT(environment)) return true;
  if (environment.QODER_REGION === "cn") return isAuthenticated();
  const mode = environment[QODER_AUTH_MODE_ENV]?.trim().toLowerCase();
  if (mode === "cli") return isAuthenticated();
  if (mode === "browser") return browserSource !== null;
  return isAuthenticated() || browserSource !== null;
}
