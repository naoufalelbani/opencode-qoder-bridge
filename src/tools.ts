import { z } from "zod";
import {
  runQoderMcpAuth,
  runQoderMcpStatus,
  runQoderCheckin,
  runQoderModels,
  runQoderPlanMode,
  runQoderSessionFork,
  runQoderSessionReset,
  runQoderSessions,
  runQoderUsage,
} from "./command-actions.js";
import type { CommandResult, QoderCommandContext } from "./command-actions.js";

/**
 * Runtime-agnostic tool table.
 *
 * `src/index.ts` wraps these specs with OpenCode 1's `tool()` helper and
 * `src/v2.ts` converts them into OpenCode 2 `Tool.Info` entries. Both entry
 * points must expose the same names and descriptions; the test suite asserts
 * that parity so the two tables cannot drift.
 */
export interface QoderToolSpec {
  readonly name: string;
  readonly description: string;
  readonly args: z.ZodRawShape;
  readonly execute: (args: any, context: QoderCommandContext) => Promise<CommandResult>;
}

/** Preserves each entry's argument inference while erasing it from the table. */
function spec<Args extends z.ZodRawShape>(value: {
  readonly name: string;
  readonly description: string;
  readonly args: Args;
  readonly execute: (args: z.infer<z.ZodObject<Args>>, context: QoderCommandContext) => Promise<CommandResult>;
}): QoderToolSpec {
  return value;
}

export function createQoderToolSpecs(
  context: () => QoderCommandContext,
): readonly QoderToolSpec[] {
  return [
    spec({
      name: "qoder_checkin",
      description: "Claim Qoder's daily credits for the browser-signed-in account.",
      args: {},
      async execute() {
        return runQoderCheckin();
      },
    }),
    spec({
      name: "qoder_usage",
      description:
        "Show Qoder account usage and quota (live), plus accumulated session cost and token totals from the local ledger.",
      args: {},
      async execute() {
        return runQoderUsage(context());
      },
    }),
    spec({
      name: "qoder_models",
      description: "List known Qoder models, capabilities, limits, and price multipliers.",
      args: {},
      async execute() {
        return runQoderModels(context());
      },
    }),
    spec({
      name: "qoder_session_reset",
      description: "Forget the persisted Qoder session mapping for a key, or use 'all' to reset all sessions.",
      args: {
        key: z
          .string()
          .optional()
          .describe(
            "Session key to reset, or 'all' to clear all persisted sessions (defaults to configured sessionKey).",
          ),
      },
      async execute(args) {
        return runQoderSessionReset(context(), args.key);
      },
    }),
    spec({
      name: "qoder_sessions",
      description: "List recent Qoder sessions with metadata (session ID, title, branch, last modified).",
      args: {
        dir: z.string().optional().describe("Working directory / project path to filter sessions (optional)."),
        limit: z
          .number()
          .optional()
          .describe("Maximum number of sessions to return (optional, default: 10)."),
      },
      async execute(args) {
        return runQoderSessions(context(), args);
      },
    }),
    spec({
      name: "qoder_session_fork",
      description:
        "Fork a persisted Qoder session into a new independent session without changing the active session mapping.",
      args: {
        sessionId: z
          .string()
          .optional()
          .describe("Source Qoder session ID (defaults to the configured/resumed session)."),
        dir: z
          .string()
          .optional()
          .describe("Working directory containing the session transcript (optional, defaults to the active project)."),
        title: z.string().optional().describe("Optional title for the fork."),
        upToMessageId: z
          .string()
          .optional()
          .describe("Optional transcript message UUID; fork only the history through this message."),
      },
      async execute(args) {
        return runQoderSessionFork(context(), args);
      },
    }),
    spec({
      name: "qoder_mcp_status",
      description: "Inspect Qoder MCP server connection and OAuth status without sending a model turn.",
      args: {},
      async execute() {
        return runQoderMcpStatus(context());
      },
    }),
    spec({
      name: "qoder_mcp_auth",
      description: "Start or complete OAuth authentication for a configured Qoder MCP server.",
      args: {
        server: z.string().describe("Configured MCP server name."),
        callbackUrl: z
          .string()
          .optional()
          .describe("OAuth callback URL copied after authorizing (omit to start the flow)."),
        redirectUri: z.string().optional().describe("Optional redirect URI to use when starting OAuth."),
      },
      async execute(args) {
        return runQoderMcpAuth(context(), args);
      },
    }),
    spec({
      name: "qoder_plan_mode",
      description: "Explain Qoder Plan Mode status and configuration in OpenCode.",
      args: {},
      async execute() {
        return runQoderPlanMode();
      },
    }),
  ];
}
