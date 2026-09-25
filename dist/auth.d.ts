export type QoderRegion = "global" | "cn";
export type QoderRegionPreference = "auto" | QoderRegion;
export declare const QODER_REGION_ENV = "QODER_REGION";
export declare const QODER_CLI_PATH_ENV = "QODER_CLI_PATH";
export declare function isAuthenticated(): boolean;
/** Classify a resolved CLI path by region. Null when no CLI is resolved. */
export declare function getQoderRegion(cliPath?: string | null): QoderRegion | null;
/** Read the QODER_REGION preference (`auto` default). */
export declare function regionPreference(environment?: Record<string, string | undefined>): QoderRegionPreference;
/** Region-aware login hint for auth errors. */
export declare function cliLoginHint(environment?: Record<string, string | undefined>): string;
/**
 * Resolve the qodercli binary (global and CN region). Search order:
 *  1. QODER_CLI_PATH override (must be executable, else fall through)
 *  2. PATH (qodercli, then qoderclicn per directory)
 *  3. ~/.qoder/local and ~/.qoder-cn/local (global location first)
 *  4. ~/.qoder/bin/qodercli and ~/.qoder-cn/bin/qoderclicn (latest
 *     versioned binary; global wins version ties)
 * QODER_REGION=global|cn restricts discovery to one region (default auto).
 * Returns null when no separately installed CLI is found. The Qoder SDK can
 * still run through its bundled Worker runtime when credentials are present.
 */
export declare function findQoderCLI(force?: boolean): string | null;
export declare function resetCachedCliPath(): void;
//# sourceMappingURL=auth.d.ts.map