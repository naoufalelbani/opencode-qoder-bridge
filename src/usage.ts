import { query } from "@qoder-ai/qoder-agent-sdk";
import type { UsageInfo } from "@qoder-ai/qoder-agent-sdk";
import { findQoderCLI } from "./auth.js";
import { idlePrompt } from "./sdk-session.js";
import { hasQoderCredential, qoderAuth } from "./sdk-auth.js";
import { debug, describeError } from "./logger.js";
import { closeAsyncIterator, withTimeout } from "./async-utils.js";

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const CLEANUP_GRACE_MS = 5_000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

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

  const request = (async () => {
    const abortController = new AbortController();
    let q: ReturnType<typeof query> | undefined;
    const timeout = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
    if (typeof timeout.unref === "function") timeout.unref();

    try {
      if (!hasQoderCredential()) return null;
      const cli = findQoderCLI();
      q = query({
        prompt: idlePrompt(abortController.signal),
        options: {
          auth: qoderAuth(),
          abortController,
          maxTurns: 1,
          persistSession: false,
          ...(cli ? { pathToQoderCLIExecutable: cli } : {}),
        },
      });
      const usage = await withTimeout(
        q.getUsageInfo(),
        FETCH_TIMEOUT_MS,
        `Qoder usage request exceeded ${FETCH_TIMEOUT_MS}ms`,
      );
      if (usage) {
        cached = usage;
        cacheExpiry = Date.now() + CACHE_TTL_MS;
      }
      return usage ?? cached;
    } catch (error) {
      debug("Live usage fetch failed:", describeError(error));
      return cached;
    } finally {
      clearTimeout(timeout);
      abortController.abort();
      if (q) await closeAsyncIterator(q, CLEANUP_GRACE_MS);
    }
  })();
  inflight = request;
  request.then(
    () => { if (inflight === request) inflight = null; },
    () => { if (inflight === request) inflight = null; },
  );
  return request;
}

export function invalidateUsageCache(): void {
  cached = null;
  cacheExpiry = 0;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeLabel(value: unknown, maxLength = 128): string {
  return typeof value === "string" ? value.replace(CONTROL_CHARS, " ").slice(0, maxLength) : "";
}

function bucketLine(label: string, b: { used?: number; total?: number; remaining?: number; unit?: string } | undefined): string | null {
  if (!b || typeof b.total !== "number" || !Number.isFinite(b.total) || b.total < 0) return null;
  const total = b.total;
  const unit = safeLabel(b.unit);
  return `${label}: ${finiteNonNegative(b.used)}/${total} ${unit} (${finiteNonNegative(b.remaining)} remaining)`;
}

/** Format a UsageInfo into a compact human-readable report. */
export function formatUsageReport(u: UsageInfo): string {
  const lines: string[] = ["Qoder Account Usage"];
  const userType = safeLabel(u.userType);
  if (userType) lines.push(`  Plan: ${userType}`);
  if (typeof u.totalUsagePercentage === "number" && Number.isFinite(u.totalUsagePercentage)) {
    lines.push(`  Usage: ${u.totalUsagePercentage.toFixed(1)}%`);
  }

  const quota = bucketLine("  Quota", u.userQuota);
  if (quota) lines.push(quota);

  if (u.addOnQuota && finiteNonNegative(u.addOnQuota.total) > 0) {
    const addOn = bucketLine("  Add-on", u.addOnQuota);
    if (addOn) lines.push(addOn);
  }

  if (u.orgResourcePackage?.available) {
    const org = u.orgResourcePackage;
    lines.push(`  Org Package: ${finiteNonNegative(org.used)}/${finiteNonNegative(org.cap)} ${safeLabel(org.unit)} (${finiteNonNegative(org.remaining)} remaining)`);
  }

  if (u.isQuotaExceeded) lines.push("  WARNING: quota exceeded");
  if (typeof u.expiresAt === "number" && Number.isFinite(u.expiresAt) && u.expiresAt > 0) {
    const expires = new Date(u.expiresAt);
    if (!Number.isNaN(expires.getTime())) lines.push(`  Expires: ${expires.toISOString().slice(0, 10)}`);
  }

  return lines.join("\n");
}
