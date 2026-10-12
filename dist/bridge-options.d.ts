import type { ModelDiscoveryOptions } from "./models.js";
import type { QoderBridgeOptions } from "./types.js";
export declare const MODEL_STARTUP_DISCOVERY_TIMEOUT_MS = 10000;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function discoveryEnvironment(value: unknown): Record<string, string | undefined>;
export declare function discoveryOptions(options: Record<string, unknown>): ModelDiscoveryOptions;
export declare function warnOnUnsafeOptions(options: Record<string, unknown>, cwd: string): void;
export interface BridgeSettingsInput {
    /** Provider settings the user already configured (`providers.qoder.settings`). */
    readonly existing: Record<string, unknown>;
    /** OpenCode's project directory, used as the default working directory. */
    readonly workspaceCwd?: string;
    /** OpenCode's resolved MCP servers, forwarded to the Qoder SDK. */
    readonly mcpServers?: Record<string, unknown>;
}
export interface NormalizedBridgeSettings {
    readonly settings: QoderBridgeOptions;
    readonly cwd: string;
    readonly sessionKey?: string;
    readonly sessionId?: string;
    readonly environment: Record<string, string | undefined>;
    readonly discovery: ModelDiscoveryOptions;
}
/**
 * Merge user provider settings with the bridge defaults. Both entry points
 * (OpenCode 1's `config` hook and OpenCode 2's provider transform) funnel
 * through here so a workspace never gets two different option resolutions.
 */
export declare function normalizeBridgeSettings(input: BridgeSettingsInput): NormalizedBridgeSettings;
//# sourceMappingURL=bridge-options.d.ts.map