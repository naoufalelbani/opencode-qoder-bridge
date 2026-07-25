/**
 * Maps qodercli tool names to opencode tool names and normalizes their inputs.
 *
 * - Casing: Read -> read, Bash -> bash
 * - Builtins: AskUserQuestion -> question, Agent -> task, ExitPlanMode -> plan_exit
 * - MCP proxy: mcp__{server}__{tool} -> {server}_{tool}
 */
export declare function normalizeToolName(name: string): string;
/** Normalize a parsed tool-input object for the given (already normalized) tool name. */
export declare function normalizeToolInput(toolName: string, input: unknown): unknown;
/** Parse a JSON input string, normalize, and re-serialize. Falls back to the original on parse error. */
export declare function normalizeToolInputString(toolName: string, input: string): string;
//# sourceMappingURL=tool-normalizer.d.ts.map