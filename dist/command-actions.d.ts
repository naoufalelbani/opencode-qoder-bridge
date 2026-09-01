import type { Query } from "@qoder-ai/qoder-agent-sdk";
import type { ModelDiscoveryOptions } from "./models.js";
import type { QoderBridgeOptions } from "./types.js";
export declare const QODER_COMMANDS: readonly [{
    readonly name: "qoder_usage";
    readonly title: "Qoder Usage";
    readonly description: "Show live Qoder quota and local cost/token totals.";
    readonly argumentHint: "";
}, {
    readonly name: "qoder_models";
    readonly title: "Qoder Models";
    readonly description: "List available Qoder models and capabilities.";
    readonly argumentHint: "";
}, {
    readonly name: "qoder_sessions";
    readonly title: "Qoder Sessions";
    readonly description: "List recent Qoder sessions.";
    readonly argumentHint: "optional: [directory] [limit]";
}, {
    readonly name: "qoder_session_reset";
    readonly title: "Reset Qoder Session";
    readonly description: "Reset a persisted Qoder session key, or all sessions.";
    readonly argumentHint: "optional: session key or all";
}, {
    readonly name: "qoder_session_fork";
    readonly title: "Fork Qoder Session";
    readonly description: "Fork a Qoder session without changing the active mapping.";
    readonly argumentHint: "optional: sessionId dir title upToMessageId";
}, {
    readonly name: "qoder_mcp_status";
    readonly title: "Qoder MCP Status";
    readonly description: "Inspect Qoder MCP connection and OAuth status.";
    readonly argumentHint: "";
}, {
    readonly name: "qoder_mcp_auth";
    readonly title: "Qoder MCP OAuth";
    readonly description: "Start or complete Qoder MCP OAuth.";
    readonly argumentHint: "server [callbackUrl] [redirectUri]";
}, {
    readonly name: "qoder_plan_mode";
    readonly title: "Qoder Plan Mode";
    readonly description: "Show Qoder Plan Mode status and configuration guidance.";
    readonly argumentHint: "";
}];
export type QoderCommandName = (typeof QODER_COMMANDS)[number]["name"];
export type CommandResult = {
    title: string;
    output: string;
    variant?: "info" | "success" | "warning" | "error";
};
export type PendingMcpAuth = {
    query: Query;
    close: () => Promise<void>;
    timer: ReturnType<typeof setTimeout>;
};
export type QoderCommandContext = {
    configuredCwd: string;
    configuredSessionKey?: string;
    configuredSessionId?: string;
    configuredBridgeOptions: QoderBridgeOptions;
    modelEnvironment?: Record<string, string | undefined>;
    modelOptions?: ModelDiscoveryOptions;
    pendingMcpAuth: Map<string, PendingMcpAuth>;
};
export type QoderSessionsArguments = {
    dir?: string;
    limit?: number;
};
export type QoderSessionForkArguments = {
    sessionId?: string;
    dir?: string;
    title?: string;
    upToMessageId?: string;
};
export type QoderMcpAuthArguments = {
    server: string;
    callbackUrl?: string;
    redirectUri?: string;
};
export declare function safeDisplay(value: unknown, fallback: string, maxLength?: number): string;
export declare function closePendingMcpAuth(pendingMcpAuth: Map<string, PendingMcpAuth>, serverName: string): Promise<void>;
export declare function closeAllPendingMcpAuth(pendingMcpAuth: Map<string, PendingMcpAuth>): Promise<void>;
export declare function runQoderUsage(_context: QoderCommandContext): Promise<CommandResult>;
export declare function runQoderModels(context: QoderCommandContext): Promise<CommandResult>;
export declare function runQoderSessions(_context: QoderCommandContext, input?: QoderSessionsArguments): Promise<CommandResult>;
export declare function runQoderSessionReset(context: QoderCommandContext, key?: string): Promise<CommandResult>;
export declare function runQoderSessionFork(context: QoderCommandContext, input?: QoderSessionForkArguments): Promise<CommandResult>;
export declare function runQoderMcpStatus(context: QoderCommandContext): Promise<CommandResult>;
export declare function runQoderMcpAuth(context: QoderCommandContext, input: QoderMcpAuthArguments): Promise<CommandResult>;
export declare function runQoderPlanMode(): CommandResult;
export declare function executeQoderCommand(name: string, rawArguments: string, context: QoderCommandContext): Promise<CommandResult>;
//# sourceMappingURL=command-actions.d.ts.map