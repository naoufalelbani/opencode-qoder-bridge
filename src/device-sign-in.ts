import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthOAuthResult } from "@opencode-ai/plugin";
import { QoderAuthError } from "./errors.js";

const CLIENT_ID = "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa";
const WEBSITE = "https://qoder.com";
const OPENAPI = "https://openapi.qoder.sh";
const MAX_WAIT_MS = 15 * 60_000;
const POLL_MS = 2_000;
const REQUEST_MS = 20_000;
const DEFAULT_TOKEN_MS = 24 * 60 * 60_000;

type JsonObject = Record<string, unknown>;

export interface DeviceSignInDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expiry(value: unknown, now: number): number {
  const milliseconds = typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 365 * DEFAULT_TOKEN_MS)
    : DEFAULT_TOKEN_MS;
  return now + milliseconds;
}

async function qoderRequest(
  path: string,
  fetcher: typeof fetch,
  options: { method?: "GET" | "POST"; token?: string; body?: JsonObject; query?: URLSearchParams } = {},
): Promise<{ status: number; body: JsonObject }> {
  const url = new URL(path, OPENAPI);
  if (options.query) url.search = options.query.toString();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body) headers["Content-Type"] = "application/json";
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
export async function qoderDeviceSignIn(dependencies: DeviceSignInDependencies = {}): Promise<AuthOAuthResult> {
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? ((ms: number) => delay(ms));
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const nonce = randomUUID();
  const machineId = randomUUID();
  const signInUrl = new URL("/device/selectAccounts", WEBSITE);
  signInUrl.search = new URLSearchParams({
    challenge,
    challenge_method: "S256",
    nonce,
    machine_id: machineId,
    client_id: CLIENT_ID,
    redirect_uri: "qoder-app://",
  }).toString();
  const deadline = now() + MAX_WAIT_MS;

  return {
    url: signInUrl.href,
    instructions: "Sign in to Qoder in the browser and authorize this device.",
    method: "auto",
    async callback() {
      let deviceToken: string | undefined;
      while (now() < deadline) {
        try {
          const reply = await qoderRequest("/api/v1/deviceToken/poll", fetcher, {
            query: new URLSearchParams({ nonce, verifier, challenge_method: "S256" }),
          });
          if (reply.status === 200) deviceToken = nonempty(reply.body.token);
          if (deviceToken) break;
        } catch {
          // A transient polling failure should not discard an authorization in progress.
        }
        await wait(Math.min(POLL_MS, Math.max(0, deadline - now())));
      }
      if (!deviceToken) throw new QoderAuthError("Qoder browser sign-in timed out; start sign-in again.");

      const job = await qoderRequest("/api/v1/me/jobToken", fetcher, {
        method: "POST",
        token: deviceToken,
        body: { clientId: CLIENT_ID },
      });
      const access = nonempty(job.body.token);
      const refresh = nonempty(job.body.refresh_token);
      if (job.status !== 200 || !access || !refresh) {
        throw new QoderAuthError(`Qoder did not issue a complete SDK job token (HTTP ${job.status}); sign in again.`);
      }

      let accountId: string | undefined;
      try {
        const user = await qoderRequest("/api/v1/userinfo", fetcher, { token: deviceToken });
        if (user.status === 200) accountId = nonempty(user.body.email);
      } catch {
        // Account labels are optional; the job token is sufficient for the SDK.
      }
      return {
        type: "success",
        access,
        refresh,
        expires: expiry(job.body.expires_in, now()),
        ...(accountId ? { accountId } : {}),
      };
    },
  };
}

export async function refreshQoderJobToken(
  refreshToken: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<{ access: string; refresh: string; expires: number }> {
  if (!refreshToken.trim()) throw new QoderAuthError("Qoder browser sign-in has expired; sign in again.");
  const url = new URL("/api/v1/jobToken/refresh", OPENAPI);
  const response = await fetcher(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
  });
  if (response.status === 401 || response.status === 403) {
    throw new QoderAuthError("Qoder browser sign-in has expired; sign in again.");
  }
  if (!response.ok) throw new QoderAuthError(`Qoder token refresh failed (HTTP ${response.status}).`);
  const body = record(await response.json().catch(() => null));
  const access = nonempty(body.token);
  const refresh = nonempty(body.refresh_token);
  if (!access || !refresh) throw new QoderAuthError("Qoder returned an incomplete refreshed token pair; sign in again.");
  return { access, refresh, expires: expiry(body.expires_in, now()) };
}
