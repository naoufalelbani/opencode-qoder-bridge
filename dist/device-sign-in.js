import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { QoderAuthError } from "./errors.js";
import { saveQoderDeviceAccount } from "./device-account.js";
import { cnVpcOpenApiEndpoint, normalizeCnVpcEndpoint } from "./cn-vpc.js";
const CLIENT_ID = "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa";
const WEBSITE = "https://qoder.com";
const OPENAPI = "https://openapi.qoder.sh";
const CN_CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
const CN_WEBSITE = "https://qoder.cn";
const CN_OPENAPI = "https://openapi.qoder.com.cn";
const MAX_WAIT_MS = 15 * 60_000;
const POLL_MS = 2_000;
const REQUEST_MS = 20_000;
const DEFAULT_TOKEN_MS = 24 * 60 * 60_000;
const CN_JOB_REFRESH_PREFIX = "qoder-cn-job:";
const CN_DEVICE_REFRESH_PREFIX = "qoder-cn-device:";
const CN_VPC_REFRESH_PREFIX = "qoder-cn-vpc:";
export function encodeRefreshToken(region, kind, token, vpcEndpoint) {
    if (region !== "cn")
        return token;
    if (vpcEndpoint)
        return `${CN_VPC_REFRESH_PREFIX}${Buffer.from(vpcEndpoint).toString("base64url")}:${kind}:${token}`;
    return `${kind === "device" ? CN_DEVICE_REFRESH_PREFIX : CN_JOB_REFRESH_PREFIX}${token}`;
}
export function decodeRefreshToken(token) {
    if (token.startsWith(CN_VPC_REFRESH_PREFIX)) {
        const [, encoded = "", kind = "", ...parts] = token.split(":");
        try {
            const vpcEndpoint = normalizeCnVpcEndpoint(Buffer.from(encoded, "base64url").toString("utf8"));
            if (vpcEndpoint && (kind === "job" || kind === "device") && parts.length > 0) {
                return { region: "cn", kind, token: parts.join(":"), vpcEndpoint };
            }
        }
        catch { /* malformed token falls through to the ordinary refresh token path */ }
    }
    if (token.startsWith(CN_DEVICE_REFRESH_PREFIX)) {
        return { region: "cn", kind: "device", token: token.slice(CN_DEVICE_REFRESH_PREFIX.length) };
    }
    if (token.startsWith(CN_JOB_REFRESH_PREFIX)) {
        return { region: "cn", kind: "job", token: token.slice(CN_JOB_REFRESH_PREFIX.length) };
    }
    return { region: "global", kind: "job", token };
}
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function nonempty(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function expiry(value, now) {
    const milliseconds = typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.min(Math.floor(value), 365 * DEFAULT_TOKEN_MS)
        : DEFAULT_TOKEN_MS;
    return now + milliseconds;
}
async function qoderRequest(path, fetcher, baseUrl = OPENAPI, options = {}) {
    const url = new URL(path, baseUrl);
    if (options.query)
        url.search = options.query.toString();
    const headers = { Accept: "application/json" };
    if (options.token)
        headers.Authorization = `Bearer ${options.token}`;
    if (options.body)
        headers["Content-Type"] = "application/json";
    const response = await fetcher(url, {
        method: options.method ?? "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_MS),
    });
    const body = record(await response.json().catch(() => null));
    return { status: response.status, body };
}
/** Qoder desktop's browser device flow. The resulting job token is consumed by the SDK. */
export async function qoderDeviceSignIn(dependencies = {}, region = "global", vpcEndpoint) {
    const fetcher = dependencies.fetch ?? fetch;
    const now = dependencies.now ?? Date.now;
    const wait = dependencies.wait ?? ((ms) => delay(ms));
    const clientId = region === "cn" ? CN_CLIENT_ID : CLIENT_ID;
    const normalizedVpc = region === "cn" && vpcEndpoint ? normalizeCnVpcEndpoint(vpcEndpoint) : undefined;
    if (vpcEndpoint && !normalizedVpc)
        throw new QoderAuthError("Enter a valid Qoder CN enterprise VPC instance name or HTTPS address.");
    const website = normalizedVpc ? `https://${normalizedVpc.replace(/-gateway\./, ".")}` : region === "cn" ? CN_WEBSITE : WEBSITE;
    const openapi = normalizedVpc ? `https://${cnVpcOpenApiEndpoint(normalizedVpc)}` : region === "cn" ? CN_OPENAPI : OPENAPI;
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const nonce = randomUUID();
    const machineId = randomUUID();
    const signInUrl = new URL("/device/selectAccounts", website);
    signInUrl.search = new URLSearchParams({
        challenge,
        challenge_method: "S256",
        nonce,
        machine_id: machineId,
        client_id: clientId,
        ...(region === "global" ? { redirect_uri: "qoder-app://" } : {}),
    }).toString();
    const deadline = now() + MAX_WAIT_MS;
    return {
        url: signInUrl.href,
        instructions: normalizedVpc
            ? "Sign in to your Qoder CN enterprise VPC in the browser and authorize this device."
            : "Sign in to Qoder in the browser and authorize this device.",
        method: "auto",
        async callback() {
            let deviceToken;
            let deviceCredential = {};
            while (now() < deadline) {
                try {
                    const reply = await qoderRequest("/api/v1/deviceToken/poll", fetcher, openapi, {
                        query: new URLSearchParams({ nonce, verifier, challenge_method: "S256" }),
                    });
                    if (reply.status === 200) {
                        deviceCredential = reply.body;
                        deviceToken = nonempty(reply.body.token);
                    }
                    if (deviceToken)
                        break;
                }
                catch {
                    // A transient polling failure should not discard an authorization in progress.
                }
                await wait(Math.min(POLL_MS, Math.max(0, deadline - now())));
            }
            if (!deviceToken)
                throw new QoderAuthError("Qoder browser sign-in timed out; start sign-in again.");
            const job = await qoderRequest("/api/v1/me/jobToken", fetcher, openapi, {
                method: "POST",
                token: deviceToken,
                body: { clientId },
            });
            let access = nonempty(job.body.token);
            let refresh = nonempty(job.body.refresh_token);
            let expires = expiry(job.body.expires_in, now());
            let tokenKind = "job";
            if (region === "cn" && job.status >= 400 && job.status < 500) {
                access = deviceToken;
                refresh = nonempty(deviceCredential.refresh_token);
                expires = deviceExpiry(deviceCredential, now());
                tokenKind = "device";
            }
            if ((job.status !== 200 && tokenKind !== "device") || !access || !refresh) {
                throw new QoderAuthError(`Qoder did not issue a complete sign-in token (HTTP ${job.status}); sign in again.`);
            }
            let accountId = nonempty(deviceCredential.email);
            let uid = nonempty(deviceCredential.user_id) ?? nonempty(deviceCredential.userId) ?? nonempty(deviceCredential.uid);
            try {
                const user = await qoderRequest("/api/v1/userinfo", fetcher, openapi, { token: deviceToken });
                if (user.status === 200) {
                    const userData = record(user.body.data);
                    accountId = nonempty(user.body.email) ?? nonempty(userData.email) ?? accountId;
                    uid = nonempty(user.body.id) ?? nonempty(user.body.user_id) ?? nonempty(user.body.userId)
                        ?? nonempty(user.body.uid) ?? nonempty(userData.id) ?? nonempty(userData.user_id)
                        ?? nonempty(userData.userId) ?? nonempty(userData.uid) ?? uid;
                }
            }
            catch {
                // Account labels are optional; the job token is sufficient for the SDK.
            }
            const deviceRefresh = nonempty(deviceCredential.refresh_token);
            if (accountId && uid && deviceRefresh) {
                await saveQoderDeviceAccount({
                    region,
                    accountId,
                    uid,
                    access: deviceToken,
                    refresh: deviceRefresh,
                    expires: deviceExpiry(deviceCredential, now()),
                    ...(normalizedVpc ? { vpcEndpoint: normalizedVpc } : {}),
                }).catch(() => { });
            }
            return {
                type: "success",
                access,
                refresh: encodeRefreshToken(region, tokenKind, refresh, normalizedVpc),
                expires,
                ...(accountId ?? uid ? { accountId: accountId ?? uid } : {}),
            };
        },
    };
}
export async function refreshQoderJobToken(refreshToken, signal, fetcher = fetch, now = Date.now, requestedRegion) {
    const parsed = decodeRefreshToken(refreshToken);
    const region = requestedRegion ?? parsed.region;
    if (!parsed.token.trim())
        throw new QoderAuthError("Qoder browser sign-in has expired; sign in again.");
    const openapi = parsed.vpcEndpoint ? `https://${cnVpcOpenApiEndpoint(parsed.vpcEndpoint)}` : region === "cn" ? CN_OPENAPI : OPENAPI;
    const url = new URL("/api/v1/jobToken/refresh", openapi);
    const response = await fetcher(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: parsed.token }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
    });
    if (response.status === 401 || response.status === 403) {
        throw new QoderAuthError("Qoder browser sign-in has expired; sign in again.");
    }
    if (!response.ok)
        throw new QoderAuthError(`Qoder token refresh failed (HTTP ${response.status}).`);
    const body = record(await response.json().catch(() => null));
    const access = nonempty(body.token);
    const refresh = nonempty(body.refresh_token);
    if (!access || !refresh)
        throw new QoderAuthError("Qoder returned an incomplete refreshed token pair; sign in again.");
    return { access, refresh: encodeRefreshToken(region, "job", refresh, parsed.vpcEndpoint), expires: expiry(body.expires_in, now()) };
}
export async function refreshQoderDeviceToken(refreshToken, signal, fetcher = fetch, now = Date.now) {
    const parsed = decodeRefreshToken(refreshToken);
    if (!parsed.token.trim())
        throw new QoderAuthError("Qoder CN browser sign-in has expired; sign in again.");
    const openapi = parsed.vpcEndpoint ? `https://${cnVpcOpenApiEndpoint(parsed.vpcEndpoint)}` : CN_OPENAPI;
    const response = await fetcher(new URL("/api/v1/deviceToken/refresh", openapi), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: parsed.token }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
    });
    if (response.status === 401 || response.status === 403) {
        throw new QoderAuthError("Qoder CN browser sign-in has expired; sign in again.");
    }
    if (!response.ok)
        throw new QoderAuthError(`Qoder CN device token refresh failed (HTTP ${response.status}).`);
    const body = record(await response.json().catch(() => null));
    const access = nonempty(body.token) ?? nonempty(body.device_token);
    const refresh = nonempty(body.refresh_token);
    if (!access || !refresh)
        throw new QoderAuthError("Qoder CN returned an incomplete refreshed device token pair; sign in again.");
    return { access, refresh: encodeRefreshToken("cn", "device", refresh, parsed.vpcEndpoint), expires: deviceExpiry(body, now()) };
}
export async function refreshQoderBrowserToken(refreshToken, signal, fetcher = fetch, now = Date.now) {
    const parsed = decodeRefreshToken(refreshToken);
    return parsed.kind === "device"
        ? refreshQoderDeviceToken(refreshToken, signal, fetcher, now)
        : refreshQoderJobToken(refreshToken, signal, fetcher, now, parsed.region);
}
function deviceExpiry(value, now) {
    const body = record(value);
    const date = nonempty(body.expires_at);
    if (date) {
        const parsed = Date.parse(date);
        if (Number.isFinite(parsed) && parsed > now)
            return parsed;
    }
    const seconds = body.expires_in;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
        return now + Math.min(seconds * 1000, 365 * DEFAULT_TOKEN_MS);
    }
    return now + DEFAULT_TOKEN_MS;
}
//# sourceMappingURL=device-sign-in.js.map