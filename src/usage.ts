import { query } from "@qoder-ai/qoder-agent-sdk";
import type { UsageInfo } from "@qoder-ai/qoder-agent-sdk";
import { findQoderCLI } from "./auth.js";
import { idlePrompt } from "./sdk-session.js";
import { hasQoderPAT, qoderAuth } from "./sdk-auth.js";

const CACHE_TTL_MS = 60_000;

let cached: UsageInfo | null = null;
let cacheExpiry = 0;
let inflight: Promise<UsageInfo | null> | null = null;

/**
 * Fetch live account usage by opening a short-lived SDK session and calling
 * `getUsageInfo()`. Results are cached for CACHE_TTL_MS and de-duplicated so
 * concurrent callers share one session.
 */
export function getLiveUsage(force = false): Promise<UsageInfo | null> {
  const now = Date.now();
  if (!force && cached && now < cacheExpiry) return Promise.resolve(cached);
  if (inflight) return inflight;

  inflight = (async () => {
    const cli = findQoderCLI();
    if (!cli && !hasQoderPAT()) return null;

    const abortController = new AbortController();
    const sdkOptions = {
      auth: qoderAuth(),
      abortController,
      maxTurns: 1,
      ...(cli ? { pathToQoderCLIExecutable: cli } : {}),
    };
    const q = query({
      prompt: idlePrompt(abortController.signal),
      options: sdkOptions,
    });

    try {
      const usage = await q.getUsageInfo();
      if (usage) {
        cached = usage;
        cacheExpiry = Date.now() + CACHE_TTL_MS;
      }
      return usage;
    } catch {
      return cached;
    } finally {
      abortController.abort();
      void q.return(undefined).catch(() => {});
      inflight = null;
    }
  })();

  return inflight;
}

export function invalidateUsageCache(): void {
  cached = null;
  cacheExpiry = 0;
}

function bucketLine(label: string, b: { used?: number; total?: number; remaining?: number; unit?: string } | undefined): string | null {
  if (!b || b.total == null) return null;
  const unit = b.unit ?? "";
  return `${label}: ${b.used ?? 0}/${b.total} ${unit} (${b.remaining ?? 0} remaining)`;
}

/** Format a UsageInfo into a compact human-readable report. */
export function formatUsageReport(u: UsageInfo): string {
  const lines: string[] = ["Qoder Account Usage"];
  if (u.userType) lines.push(`  Plan: ${u.userType}`);
  if (typeof u.totalUsagePercentage === "number") lines.push(`  Usage: ${u.totalUsagePercentage.toFixed(1)}%`);

  const quota = bucketLine("  Quota", u.userQuota);
  if (quota) lines.push(quota);

  if (u.addOnQuota && (u.addOnQuota.total ?? 0) > 0) {
    const addOn = bucketLine("  Add-on", u.addOnQuota);
    if (addOn) lines.push(addOn);
  }

  if (u.orgResourcePackage?.available) {
    const org = u.orgResourcePackage;
    lines.push(`  Org Package: ${org.used ?? 0}/${org.cap ?? 0} ${org.unit ?? ""} (${org.remaining ?? 0} remaining)`);
  }

  if (u.isQuotaExceeded) lines.push("  WARNING: quota exceeded");
  if (u.expiresAt && u.expiresAt > 0) lines.push(`  Expires: ${new Date(u.expiresAt).toISOString().slice(0, 10)}`);

  return lines.join("\n");
}
