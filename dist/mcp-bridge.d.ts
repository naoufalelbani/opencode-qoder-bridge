type McpServerConfig = Record<string, unknown>;
/**
 * Bridge opencode `config.mcp` into SDK `mcpServers`.
 * Disabled and unrecognized entries are dropped.
 */
export declare function bridgeMcpServers(mcp: unknown): Record<string, McpServerConfig>;
/**
 * Bridge OpenCode 2's resolved `ctx.mcp` editor entries into SDK `mcpServers`.
 * Disabled and unrecognized entries are dropped.
 */
export declare function bridgeMcpServersV2(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, McpServerConfig>;
export {};
//# sourceMappingURL=mcp-bridge.d.ts.map