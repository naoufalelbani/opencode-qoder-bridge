import type { McpServerStatus, Query } from "@qoder-ai/qoder-agent-sdk";
import type { QoderBridgeOptions } from "./types.js";
export declare const MCP_CONTROL_TIMEOUT_MS = 30000;
export type SdkControlSession = {
    query: Query;
    close: () => Promise<void>;
};
/**
 * Start an initialized, prompt-gated SDK query for control operations such as
 * MCP status/OAuth. The idle prompt keeps the same Query alive between the two
 * OAuth tool calls, which is required by Qoder's active OAuth flow.
 */
export declare function openSdkControlSession(bridgeOptions: QoderBridgeOptions, cwd: string): Promise<SdkControlSession>;
export declare function withMcpControlTimeout<T>(operation: PromiseLike<T>, label: string): Promise<T>;
export declare function formatMcpStatuses(statuses: McpServerStatus[]): string;
//# sourceMappingURL=sdk-control.d.ts.map