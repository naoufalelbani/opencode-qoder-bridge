import { isAuthenticated, isAuthenticatedForRegion } from "./auth.js";
import { decodeRefreshToken, refreshQoderBrowserToken } from "./device-sign-in.js";
import { QoderAuthError } from "./errors.js";
import { readStoredBrowserCredential, writeStoredBrowserCredential } from "./opencode-auth-store.js";
export const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN";
export const QODER_AUTH_MODE_ENV = "QODER_AUTH_MODE";
const REFRESH_LEAD_MS = 5 * 60_000;
let browserSource = null;
let refreshInFlight = null;
const issuedTokens = new Map();
/** OpenCode owns the saved OAuth credential; the bridge only holds accessors. */
export function configureBrowserAuth(source) {
    if (browserSource?.accountId !== source?.accountId || browserSource?.region !== source?.region || browserSource?.vpcEndpoint !== source?.vpcEndpoint) {
        refreshInFlight = null;
        issuedTokens.clear();
    }
    browserSource = source;
    if (!source) {
        refreshInFlight = null;
        issuedTokens.clear();
    }
}
function ensureBrowserSource(environment) {
    if (browserSource && !browserSource.storeBacked)
        return;
    if (environment.OPENCODE_AUTH_CONTENT) {
        if (browserSource?.storeBacked)
            configureBrowserAuth(null);
        return;
    }
    const saved = readStoredBrowserCredential(environment);
    if (!saved) {
        if (browserSource?.storeBacked)
            configureBrowserAuth(null);
        return;
    }
    if (browserSource?.storeBacked
        && browserSource.accountId === saved.accountId
        && browserSource.region === decodeRefreshToken(saved.refresh).region)
        return;
    configureBrowserAuth({
        accountId: saved.accountId,
        region: decodeRefreshToken(saved.refresh).region,
        storeBacked: true,
        read: async () => readStoredBrowserCredential(environment),
        write: (updated, previous) => writeStoredBrowserCredential(updated, previous, environment),
    });
}
function browserMatchesEnvironment(environment) {
    if (!browserSource)
        return false;
    const requested = environment.QODER_REGION?.trim().toLowerCase();
    const region = browserSource.region ?? "global";
    return (requested !== "cn" && requested !== "global") || region === requested;
}
export function browserAuthIdentity(environment = process.env) {
    ensureBrowserSource(environment);
    if (!browserSource)
        return undefined;
    const identity = browserSource.accountId ?? "browser-account";
    return browserSource.region === "cn" ? `cn:${identity}` : identity;
}
export function browserAuthRegion() {
    return browserSource?.region;
}
export function browserAuthVpcEndpoint() {
    return browserSource?.vpcEndpoint;
}
/** Keep a saved VPC credential on the CN SDK and CN CLI search path. */
export function applyBrowserAuthRegion(environment) {
    if (browserSource?.vpcEndpoint && environment.QODER_REGION?.trim().toLowerCase() !== "global") {
        return { ...environment, QODER_REGION: "cn" };
    }
    return environment;
}
function rememberIssued(requestId, token) {
    if (!requestId)
        return;
    issuedTokens.set(requestId, token);
    if (issuedTokens.size > 512)
        issuedTokens.delete(issuedTokens.keys().next().value);
}
async function currentJobToken(requestId, reason, signal) {
    const source = browserSource;
    if (!source)
        return null;
    const current = await source.read();
    if (!current || !current.access.trim())
        return null;
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
            if (!latest || !latest.refresh.trim())
                throw new QoderAuthError("Qoder browser sign-in has expired; sign in again.");
            if (latest.access !== current.access && latest.expires > Date.now() + REFRESH_LEAD_MS)
                return latest;
            const renewed = await refreshQoderBrowserToken(latest.refresh, signal);
            const updated = { ...latest, ...renewed, type: "oauth" };
            try {
                await source.write(updated, latest);
            }
            catch (error) {
                const changed = await source.read();
                if (changed?.access !== latest.access && changed && changed.expires > Date.now() + REFRESH_LEAD_MS)
                    return changed;
                throw error;
            }
            return updated;
        })();
        refreshInFlight = operation;
        operation.then(() => { if (refreshInFlight === operation)
            refreshInFlight = null; }, () => { if (refreshInFlight === operation)
            refreshInFlight = null; });
    }
    const refreshed = await refreshInFlight;
    rememberIssued(requestId, refreshed.access);
    return { token: refreshed.access, expiresAt: refreshed.expires };
}
export function hasQoderPAT(environment = process.env) {
    return Boolean(environment[QODER_PAT_ENV]?.trim());
}
/** PAT, CLI login, and browser sign-in all drive the same SDK runtime. */
export function qoderAuth(environment = process.env) {
    ensureBrowserSource(environment);
    const token = environment[QODER_PAT_ENV];
    if (token?.trim()) {
        // Keep the SDK's env-backed auth shape for normal values, but avoid sending
        // accidental surrounding whitespace when a caller configured a token that
        // was copied from a shell or secret store.
        return { type: "accessToken", accessToken: token.trim() };
    }
    const mode = environment[QODER_AUTH_MODE_ENV]?.trim().toLowerCase();
    if (mode === "browser" && browserMatchesEnvironment(environment)) {
        return {
            type: "jobToken",
            fetchJobToken: (request, options) => currentJobToken(request.requestId, request.reason, options.signal),
        };
    }
    if (mode !== "cli" && browserSource?.vpcEndpoint && browserMatchesEnvironment(environment)) {
        return {
            type: "jobToken",
            fetchJobToken: (request, options) => currentJobToken(request.requestId, request.reason, options.signal),
        };
    }
    // The installed Qoder CLI is the fastest known path on machines already
    // logged in with it. Browser auth remains the fallback and can be selected
    // explicitly when the two sign-ins belong to different accounts.
    if (mode === "cli" || (mode !== "browser" && environment.QODER_REGION === "cn" && isAuthenticatedForRegion("cn"))
        || (environment.QODER_REGION !== "cn" && mode !== "browser" && isAuthenticated())) {
        return { type: "qodercli" };
    }
    if (browserMatchesEnvironment(environment)) {
        return {
            type: "jobToken",
            fetchJobToken: (request, options) => currentJobToken(request.requestId, request.reason, options.signal),
        };
    }
    return { type: "qodercli" };
}
export function hasQoderCredential(environment = process.env) {
    ensureBrowserSource(environment);
    if (hasQoderPAT(environment))
        return true;
    const mode = environment[QODER_AUTH_MODE_ENV]?.trim().toLowerCase();
    if (mode === "cli")
        return isAuthenticated();
    if (mode === "browser")
        return browserMatchesEnvironment(environment);
    if (mode !== "cli" && browserSource?.vpcEndpoint && browserMatchesEnvironment(environment))
        return true;
    if (environment.QODER_REGION === "cn")
        return isAuthenticatedForRegion("cn") || browserSource?.region === "cn";
    return isAuthenticated() || browserMatchesEnvironment(environment);
}
//# sourceMappingURL=sdk-auth.js.map