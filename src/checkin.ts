import { spawn } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { browserAuthIdentity, browserAuthRegion, browserAuthVpcEndpoint } from "./sdk-auth.js";
import { readQoderDeviceAccount, saveQoderDeviceAccount } from "./device-account.js";
import type { QoderDeviceAccount } from "./device-account.js";
import { describeError } from "./logger.js";
import { cnVpcOpenApiEndpoint, normalizeCnVpcEndpoint } from "./cn-vpc.js";

const CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";
const IDENTITY_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const IDENTITY_MAX_BYTES = 1_000_000;
const identityCache = new Map<string, { at: number; promise: Promise<Record<string, string>> }>();
const deviceRefreshes = new Map<string, Promise<QoderDeviceAccount>>();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validHeader(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean.length > 0 && clean.length <= 4096 && /^[\x20-\x7e]+$/.test(clean) ? clean : undefined;
}

async function executable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    if (process.platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findRuntimeInfo(environment: Record<string, string | undefined> = process.env): Promise<string> {
  const override = environment.QODER_RUNTIME_INFO?.trim();
  if (override) {
    if (!isAbsolute(override)) throw new Error("QODER_RUNTIME_INFO must be an absolute path.");
    if (await executable(override)) return override;
    throw new Error("QODER_RUNTIME_INFO does not point to an executable runtime-info helper.");
  }
  const home = homedir();
  const file = process.platform === "win32" ? "runtime-info.exe" : "runtime-info";
  const desktop: string[] = process.platform === "win32"
    ? [join(environment.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "Qoder", "resources", "umid", file)]
    : process.platform === "darwin"
      ? [join("/Applications", "Qoder.app", "Contents", "Resources", "umid", file), join(home, "Applications", "Qoder.app", "Contents", "Resources", "umid", file)]
      : process.platform === "linux"
        ? [join("/opt", "Qoder", "resources", "umid", file)]
        : [];
  for (const path of desktop) if (await executable(path)) return path;

  const config = environment.QODER_CONFIG_DIR?.trim()
    || join(environment.QODER_CLI_HOME?.trim() || home, environment.QODER_CONFIG_DIR_NAME?.trim() || ".qoder");
  const cache = join(config, ".bin");
  const entries = await readdir(cache, { withFileTypes: true }).catch(() => []);
  const matches: Array<{ path: string; modified: number }> = [];
  for (const entry of entries) {
    let path: string | undefined;
    if (process.platform === "win32") {
      if (entry.isDirectory() && entry.name.startsWith(`umid-win32-${process.arch}-`)) path = join(cache, entry.name, file);
    } else if (entry.isFile() && entry.name.startsWith(`runtime-info-${process.platform}-${process.arch}-`) && !entry.name.endsWith(".tmp")) {
      path = join(cache, entry.name);
    }
    if (path && await executable(path)) {
      matches.push({ path, modified: (await stat(path)).mtimeMs });
    }
  }
  matches.sort((a, b) => b.modified - a.modified);
  if (matches[0]) return matches[0].path;
  throw new Error("Qoder device identity helper not found. Install Qoder desktop or sign in to Qoder CLI once, or set QODER_RUNTIME_INFO.");
}

async function runRuntimeInfo(path: string, uid: string): Promise<string> {
  const args = process.platform === "linux" ? ["3"] : ["3", "--account-stdin"];
  return await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(path, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), REQUEST_TIMEOUT_MS);
    const finish = (error?: Error, output = "") => {
      clearTimeout(timeout);
      if (error) reject(error); else resolveOutput(output);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > IDENTITY_MAX_BYTES) {
        child.kill();
        finish(new Error("Qoder device identity helper returned too much data."));
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2048); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) return finish(new Error(`Qoder device identity helper failed (exit ${code}): ${stderr.trim().slice(0, 300)}`));
      finish(undefined, Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(process.platform === "linux" ? undefined : `${JSON.stringify({ account: uid })}\n`);
  });
}

async function machineHeaders(uid: string): Promise<Record<string, string>> {
  let entry = identityCache.get(uid);
  if (!entry || Date.now() - entry.at >= IDENTITY_TTL_MS) {
    const promise = (async () => {
      const path = await findRuntimeInfo();
      const output = await runRuntimeInfo(path, uid);
      let identity: Record<string, unknown>;
      try { identity = record(JSON.parse(output.trim().split(/\r?\n/, 1)[0])); }
      catch { throw new Error("Qoder device identity helper returned invalid data."); }
      const token = validHeader(identity.machineToken);
      const type = validHeader(identity.machineType);
      if (!token || !type) throw new Error("Qoder device identity helper returned an incomplete identity.");
      return { "Cosy-MachineToken": token, "Cosy-MachineType": type };
    })();
    entry = { at: Date.now(), promise };
    identityCache.set(uid, entry);
  }
  try { return await entry.promise; }
  catch (error) {
    if (identityCache.get(uid) === entry) identityCache.delete(uid);
    throw error;
  }
}

function campaignsFrom(value: unknown): Record<string, unknown>[] {
  const root = record(value);
  const data = record(root.data);
  const candidates = Array.isArray(root.campaigns) ? root.campaigns
    : Array.isArray(data.campaigns) ? data.campaigns
      : Array.isArray(root.data) ? root.data : [];
  return candidates.map(record);
}

function activeNow(campaign: Record<string, unknown>, now: number): boolean {
  const start = Date.parse(String(campaign.startAt ?? ""));
  const end = Date.parse(String(campaign.endAt ?? ""));
  return (!Number.isFinite(start) || now >= start) && (!Number.isFinite(end) || now <= end);
}

async function campaignRequest(
  region: "global" | "cn",
  deviceToken: string,
  path: string,
  method = "GET",
  machine: Record<string, string> = {},
  vpcEndpoint?: string,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const normalizedVpc = region === "cn" && vpcEndpoint ? normalizeCnVpcEndpoint(vpcEndpoint) : undefined;
  if (vpcEndpoint && !normalizedVpc) throw new Error("Saved Qoder CN VPC endpoint is invalid; sign in again.");
  const host = normalizedVpc
    ? `https://${cnVpcOpenApiEndpoint(normalizedVpc)}`
    : region === "cn" ? "https://openapi.qoder.com.cn" : "https://openapi.qoder.sh";
  const response = await fetch(new URL(path, host), {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${deviceToken}`,
      "Cosy-ClientType": "10",
      "User-Agent": "Qoder",
      ...(region === "global" ? machine : {}),
    },
    ...(method === "GET" ? {} : { body: "{}" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { response, body: record(await response.json().catch(() => null)) };
}

export async function claimDailyQoderCredits(): Promise<string> {
  const identity = browserAuthIdentity();
  const region = browserAuthRegion();
  if (!identity || !region) throw new Error("Sign in with Qoder through the browser before using daily check-in.");
  const accountId = region === "cn" && identity.startsWith("cn:") ? identity.slice(3) : identity;
  const vpcEndpoint = browserAuthVpcEndpoint();
  let credential = await readQoderDeviceAccount(region, accountId, vpcEndpoint);
  if (!credential) throw new Error("Daily check-in needs a device token from browser sign-in. Sign out and sign in again.");

  if (credential.expires <= Date.now() + 60_000) {
    credential = await renewDeviceAccount(credential);
  }

  const machine = region === "global" ? await machineHeaders(credential.uid) : {};
  let result = await campaignRequest(region, credential.access, CAMPAIGNS_PATH, "GET", machine, credential.vpcEndpoint);
  if (result.response.status === 401 || result.response.status === 403) {
    credential = await renewDeviceAccount(credential);
    result = await campaignRequest(region, credential.access, CAMPAIGNS_PATH, "GET", machine, credential.vpcEndpoint);
  }
  if (!result.response.ok) throw new Error(`Qoder campaign lookup failed (HTTP ${result.response.status}).`);
  const candidates = campaignsFrom(result.body).filter(
    (item) => item.actionType === "CLAIM_BENEFIT" && activeNow(item, Date.now()),
  );
  const campaign = candidates.find((item) => item.claimStatus === "CLAIMABLE")
    ?? candidates.find((item) => item.claimStatus === "CLAIMED");
  if (!campaign) return "No active daily credit campaign is available for this account.";
  const state = campaign.claimStatus;
  if (state === "CLAIMED") return "Today's Qoder daily credits have already been claimed.";
  if (state !== "CLAIMABLE" || typeof campaign.campaignId !== "string" || !campaign.campaignId.trim()) {
    return "Qoder's daily credit campaign is not claimable right now.";
  }
  const id = encodeURIComponent(campaign.campaignId);
  const claim = await campaignRequest(region, credential.access, `${CAMPAIGNS_PATH}/${id}/claim`, "POST", machine, credential.vpcEndpoint);
  if (!claim.response.ok) throw new Error(`Qoder daily credit claim failed (HTTP ${claim.response.status}).`);
  const claimBody = record(claim.body.data);
  const status = claim.body.status ?? claimBody.status;
  if (status !== "CLAIMED") throw new Error("Qoder did not confirm the daily credit claim.");
  const benefit = record(campaign.benefit);
  const amount = typeof benefit.amount === "number" && Number.isFinite(benefit.amount) ? ` ${benefit.amount} credits` : "";
  return `Claimed today's Qoder daily credits.${amount}`;
}

async function refreshDeviceAccount(
  account: QoderDeviceAccount,
): Promise<QoderDeviceAccount> {
  if (!account.refresh.trim()) throw new Error("Qoder device sign-in expired. Sign in again to restore daily check-in.");
  const normalizedVpc = account.region === "cn" && account.vpcEndpoint ? normalizeCnVpcEndpoint(account.vpcEndpoint) : undefined;
  if (account.vpcEndpoint && !normalizedVpc) throw new Error("Saved Qoder CN VPC endpoint is invalid; sign in again.");
  const host = normalizedVpc
    ? `https://${cnVpcOpenApiEndpoint(normalizedVpc)}`
    : account.region === "cn" ? "https://openapi.qoder.com.cn" : "https://openapi.qoder.sh";
  const response = await fetch(new URL("/api/v1/deviceToken/refresh", host), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: account.refresh }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Qoder device token refresh failed (HTTP ${response.status}); sign in again if it continues.`);
  const body = record(await response.json().catch(() => null));
  const access = typeof body.token === "string" ? body.token : typeof body.device_token === "string" ? body.device_token : "";
  const refresh = typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!access.trim() || !refresh.trim()) throw new Error("Qoder returned an incomplete device token pair; sign in again.");
  const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in * 1000 : 24 * 60 * 60_000;
  const at = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
  return { ...account, access, refresh, expires: Number.isFinite(at) && at > Date.now() ? at : Date.now() + seconds };
}

async function renewDeviceAccount(account: QoderDeviceAccount): Promise<QoderDeviceAccount> {
  const key = `${account.region}:${account.accountId}:${account.vpcEndpoint ?? ""}`;
  const pending = deviceRefreshes.get(key);
  if (pending) return pending;
  const latest = await readQoderDeviceAccount(account.region, account.accountId, account.vpcEndpoint);
  if (latest && latest.refresh !== account.refresh && latest.expires > Date.now() + 60_000) return latest;
  const operation = (async () => {
    const current = await refreshDeviceAccount(latest ?? account);
    await saveQoderDeviceAccount(current);
    return current;
  })();
  deviceRefreshes.set(key, operation);
  try { return await operation; }
  finally { if (deviceRefreshes.get(key) === operation) deviceRefreshes.delete(key); }
}

export function clearQoderCheckinIdentityCache(): void {
  identityCache.clear();
}

export function explainQoderCheckinError(error: unknown): string {
  return describeError(error);
}
