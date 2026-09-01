import type { EvolutionOptions, MemoryOptions, SecurityScanOptions } from "@qoder-ai/qoder-agent-sdk";
export interface QoderModelDef {
    id: string;
    name: string;
    attachment: boolean;
    reasoning: boolean;
    toolCall: boolean;
    /** Billing multiplier relative to the base rate. 0 = free. */
    multiplier: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    limit: {
        context: number;
        output: number;
    };
}
export interface QoderBridgeOptions {
    /** Force a transport mode. `sdk` (default) streams via the agent SDK. */
    mode?: "sdk";
    /** Working directory for the Qoder process and persisted session identity. */
    cwd?: string;
    /** Initial Plan Mode state for the main session, independent from tool permissions. */
    planMode?: boolean;
    /** Outbound proxy URL used by qodercli (e.g. http://, https://, socks5://). */
    proxy?: string;
    /** Optional private-deployment endpoint used by the Qoder SDK runtime. */
    vpcEndpoint?: string;
    /** Opt-in skill evolution configuration for the session. */
    evolution?: EvolutionOptions;
    /** Opt-in Qoder-native memory generation and context consumption. */
    memory?: MemoryOptions;
    /** Opt-in built-in code security checks; every switch defaults to false. */
    securityScan?: SecurityScanOptions;
    /** Extra CLI flags forwarded to qodercli; accepts bare or `--`-prefixed names. */
    extraArgs?: Record<string, string | null>;
    /** Bridged MCP server configs keyed by server name. */
    mcpServers?: Record<string, unknown>;
    /** Opt into resuming a persisted Qoder session. */
    sessionPersistence?: boolean;
    /** Stable key used to map this provider to a Qoder session. */
    sessionKey?: string;
    /** Explicit Qoder session ID, useful for integrations that own session state. */
    sessionId?: string;
    /** SDK permission policy. Defaults to the safe SDK policy. */
    permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
    /** Whether the SDK may skip permission checks when bypassPermissions is selected. */
    allowDangerouslySkipPermissions?: boolean;
    /** Maximum duration of a chat turn in milliseconds; defaults to 30 minutes. */
    timeoutMs?: number;
    /** Optional SDK tool allowlist. */
    allowedTools?: string[];
    /** Optional SDK tool denylist. */
    disallowedTools?: string[];
    /**
     * Extra environment variables forwarded to the Qoder SDK runtime for chat
     * turns and live model discovery.
     */
    env?: Record<string, string | undefined>;
}
export interface ModelCost {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}
//# sourceMappingURL=types.d.ts.map