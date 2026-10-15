import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { resolveStateDir } from "./state-dir.js";

export interface QoderDeviceAccount {
  region: "global" | "cn";
  accountId: string;
  uid: string;
  access: string;
  refresh: string;
  expires: number;
  vpcEndpoint?: string;
}

function fileFor(region: "global" | "cn", accountId: string, vpcEndpoint?: string): string {
  const digest = createHash("sha256").update(`${region}\0${accountId}\0${vpcEndpoint ?? ""}`).digest("hex");
  return join(resolveStateDir(), `device-account.${digest}.json`);
}

function valid(value: unknown): value is QoderDeviceAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.region === "global" || record.region === "cn")
    && typeof record.accountId === "string" && record.accountId.length > 0 && record.accountId.length <= 512
    && typeof record.uid === "string" && record.uid.length > 0 && record.uid.length <= 512
    && typeof record.access === "string" && record.access.length > 0 && record.access.length <= 16_384
    && typeof record.refresh === "string" && record.refresh.length > 0 && record.refresh.length <= 16_384
    && typeof record.expires === "number" && Number.isFinite(record.expires)
    && (record.vpcEndpoint === undefined || (typeof record.vpcEndpoint === "string" && record.vpcEndpoint.length <= 512));
}

export async function saveQoderDeviceAccount(account: QoderDeviceAccount): Promise<void> {
  if (!valid(account)) throw new Error("Qoder device account data is incomplete.");
  const directory = resolveStateDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = fileFor(account.region, account.accountId, account.vpcEndpoint);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(account));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => {});
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export async function readQoderDeviceAccount(
  region: "global" | "cn",
  accountId: string,
  vpcEndpoint?: string,
): Promise<QoderDeviceAccount | null> {
  try {
    const path = fileFor(region, accountId, vpcEndpoint);
    const info = await stat(path);
    if (!info.isFile() || info.size > 64_000) return null;
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return valid(parsed) && parsed.region === region && parsed.accountId === accountId && parsed.vpcEndpoint === vpcEndpoint ? parsed : null;
  } catch {
    return null;
  }
}
