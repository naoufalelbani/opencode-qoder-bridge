import type { UsageInfo } from "@qoder-ai/qoder-agent-sdk";
/**
 * Fetch live account usage by opening a short-lived SDK session and calling
 * `getUsageInfo()`. Results are cached for CACHE_TTL_MS and de-duplicated so
 * concurrent callers share one session.
 */
export declare function getLiveUsage(force?: boolean): Promise<UsageInfo | null>;
export declare function invalidateUsageCache(): void;
/** Format a UsageInfo into a compact human-readable report. */
export declare function formatUsageReport(u: UsageInfo): string;
//# sourceMappingURL=usage.d.ts.map