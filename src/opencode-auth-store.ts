import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserCredential } from "./sdk-auth.js";
import { QoderAuthError } from "./errors.js";

const MAX_AUTH_FILE_BYTES = 1_000_000;

function authFile(environment: NodeJS.ProcessEnv = process.env): string {
  const base = environment.XDG_DATA_HOME?.trim()
    || (process.platform === "win32"
      ? environment.APPDATA?.trim() || join(homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : join(homedir(), ".local", "share"));
  return join(base, "opencode", "auth.json");
}

function authData(path: string): Record<string, unknown> | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_AUTH_FILE_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function credential(value: unknown): BrowserCredential | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const auth = value as Record<string, unknown>;
  if (auth.type !== "oauth" || typeof auth.access !== "string" || !auth.access.trim()
    || typeof auth.refresh !== "string" || !auth.refresh.trim()
    || typeof auth.expires !== "number" || !Number.isFinite(auth.expires)) return null;
  return {
    type: "oauth", access: auth.access, refresh: auth.refresh, expires: auth.expires,
    ...(typeof auth.accountId === "string" ? { accountId: auth.accountId } : {}),
  };
}

/** Read only Qoder's OAuth entry; other OpenCode credentials are not exposed. */
export function readStoredBrowserCredential(environment: NodeJS.ProcessEnv = process.env): BrowserCredential | null {
  return credential(authData(authFile(environment))?.qoder);
}

/** Update Qoder's rotated token pair, retaining the rest of OpenCode's auth file. */
export async function writeStoredBrowserCredential(
  updated: BrowserCredential,
  previous: BrowserCredential,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = authFile(environment);
  const data = authData(path);
  const current = credential(data?.qoder);
  if (!data || !current || current.refresh !== previous.refresh || current.access !== previous.access) {
    throw new QoderAuthError("Qoder sign-in changed while refreshing; retry the request or sign in again.");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ ...data, qoder: updated }));
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Do not replace a credential another process changed while we wrote.
    const latest = readStoredBrowserCredential(environment);
    if (!latest || latest.refresh !== previous.refresh || latest.access !== previous.access) {
      throw new QoderAuthError("Qoder sign-in changed while refreshing; retry the request or sign in again.");
    }
    await rename(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (existsSync(temporary)) await unlink(temporary).catch(() => {});
  }
}
