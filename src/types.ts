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
  /** Extra CLI flags forwarded to qodercli, e.g. { "--experimental-mcp-load": null }. */
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
  /** Optional SDK tool allowlist. */
  allowedTools?: string[];
  /** Optional SDK tool denylist. */
  disallowedTools?: string[];
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
