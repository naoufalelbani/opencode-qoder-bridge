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
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
