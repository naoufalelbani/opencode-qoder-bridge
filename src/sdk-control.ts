import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { startup } from "@qoder-ai/qoder-agent-sdk";
import type { McpServerStatus, Options, Query, WarmQuery } from "@qoder-ai/qoder-agent-sdk";
import { findQoderCLI } from "./auth.js";
import { idlePrompt } from "./sdk-session.js";
import { hasQoderCredential, qoderAuth } from "./sdk-auth.js";
import { QoderAuthError } from "./errors.js";
import type { QoderBridgeOptions } from "./types.js";
import { withTimeout } from "./async-utils.js";
import { redactSensitiveText } from "./logger.js";

export const MCP_CONTROL_TIMEOUT_MS = 30_000;
const MCP_INITIALIZE_TIMEOUT_MS = 60_000;

export type SdkControlSession = {
  query: Query;
  close: () => Promise<void>;
};

function resolveCwd(value: string | undefined): string {
  if (!value?.trim()) return process.cwd();
  try {
    const resolved = resolve(value);
    try { return realpathSync(resolved); } catch { return resolved; }
  } catch {
    return process.cwd();
  }
}

function childEnvironment(environment: Record<string, string | undefined> | undefined): Record<string, string | undefined> {
  return environment ? { ...process.env, ...environment } : process.env;
}

function controlOptions(bridgeOptions: QoderBridgeOptions, cwd: string, abortController: AbortController): Options {
  const environment = childEnvironment(bridgeOptions.env);
  const options: Options = {
    auth: qoderAuth(environment),
    model: "auto",
    cwd: resolveCwd(cwd),
    abortController,
    maxTurns: 1,
    persistSession: false,
    includePartialMessages: false,
  };

  const cli = findQoderCLI();
  if (cli) options.pathToQoderCLIExecutable = cli;
  if (bridgeOptions.env) options.env = environment;
  if (bridgeOptions.proxy) options.proxy = bridgeOptions.proxy;
  if (bridgeOptions.vpcEndpoint) options.vpcEndpoint = bridgeOptions.vpcEndpoint;

  if (bridgeOptions.mcpServers && Object.keys(bridgeOptions.mcpServers).length > 0) {
    options.mcpServers = bridgeOptions.mcpServers as Options["mcpServers"];
  }
  if (bridgeOptions.extraArgs && Object.keys(bridgeOptions.extraArgs).length > 0) {
    options.extraArgs = Object.fromEntries(
      Object.entries(bridgeOptions.extraArgs).map(([key, value]) => [key.replace(/^--/, ""), value]),
    );
  }
  return options;
}

/**
 * Start an initialized, prompt-gated SDK query for control operations such as
 * MCP status/OAuth. The idle prompt keeps the same Query alive between the two
 * OAuth tool calls, which is required by Qoder's active OAuth flow.
 */
export async function openSdkControlSession(
  bridgeOptions: QoderBridgeOptions,
  cwd: string,
): Promise<SdkControlSession> {
  const environment = childEnvironment(bridgeOptions.env);
  if (!hasQoderCredential(environment)) {
    throw new QoderAuthError(
      "No Qoder credentials found. Run `qoder login` or set QODER_PERSONAL_ACCESS_TOKEN.",
    );
  }

  const abortController = new AbortController();
  let warm: WarmQuery | undefined;
  let activeQuery: Query | undefined;
  let closed = false;
  try {
    warm = await startup({
      options: controlOptions(bridgeOptions, cwd, abortController),
      initializeTimeoutMs: MCP_INITIALIZE_TIMEOUT_MS,
    });
    activeQuery = warm.query(idlePrompt(abortController.signal));

    const close = async () => {
      if (closed) return;
      closed = true;
      try { abortController.abort(); } catch { /* best-effort cancellation */ }
      try {
        if (activeQuery) await activeQuery.close();
      } catch {
        // Control operations are best effort during shutdown.
      } finally {
        // WarmQuery.close() is intentionally synchronous and idempotent; it
        // also covers initialization failures in SDK implementations that
        // close the underlying session lazily.
        try { warm?.close(); } catch { /* best effort */ }
      }
    };

    return { query: activeQuery, close };
  } catch (error) {
    try { abortController.abort(); } catch { /* best-effort cancellation */ }
    try { activeQuery && await activeQuery.close(); } catch { /* best effort */ }
    try { warm?.close(); } catch { /* best effort */ }
    throw error;
  }
}

export function withMcpControlTimeout<T>(operation: PromiseLike<T>, label: string): Promise<T> {
  return withTimeout(operation, MCP_CONTROL_TIMEOUT_MS, `Qoder MCP ${label} exceeded ${MCP_CONTROL_TIMEOUT_MS}ms`);
}

export function formatMcpStatuses(statuses: McpServerStatus[]): string {
  if (statuses.length === 0) return "No MCP servers are configured.";
  const lines = ["Qoder MCP Servers"];
  for (const status of statuses) {
    const tools = Array.isArray(status.tools) ? status.tools.length : 0;
    const details = [status.status, `${tools} tool${tools === 1 ? "" : "s"}`];
    if (status.scope) details.push(`scope: ${status.scope}`);
    lines.push(`  ${safeStatusText(status.name, "unknown")}: ${details.join(" | ")}`);
    if (status.serverInfo?.name || status.serverInfo?.version) {
      const name = safeStatusText(status.serverInfo.name, "unknown");
      const version = safeStatusText(status.serverInfo.version, "unknown");
      lines.push(`    Server: ${name} ${version}`);
    }
    if (status.error) lines.push(`    Error: ${safeStatusText(status.error, "unknown", 1_024)}`);
  }
  return lines.join("\n");
}

function safeStatusText(value: unknown, fallback: string, maxLength = 512): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return redactSensitiveText(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")).slice(0, maxLength) || fallback;
}
