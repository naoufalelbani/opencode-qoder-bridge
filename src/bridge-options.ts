import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { mergedEnvironment } from "./environment.js";
import { warn } from "./logger.js";
import type { ModelDiscoveryOptions } from "./models.js";
import type { QoderBridgeOptions } from "./types.js";

export const MODEL_STARTUP_DISCOVERY_TIMEOUT_MS = 10_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function discoveryEnvironment(value: unknown): Record<string, string | undefined> {
  return isRecord(value) ? mergedEnvironment(value as Record<string, string | undefined>) : mergedEnvironment();
}

export function discoveryOptions(options: Record<string, unknown>): ModelDiscoveryOptions {
  const result: ModelDiscoveryOptions = { timeoutMs: MODEL_STARTUP_DISCOVERY_TIMEOUT_MS };
  if (typeof options.proxy === "string" && options.proxy.trim()) result.proxy = options.proxy;
  if (typeof options.vpcEndpoint === "string" && options.vpcEndpoint.trim()) result.vpcEndpoint = options.vpcEndpoint;
  if (typeof options.cwd === "string" && options.cwd.trim()) result.cwd = options.cwd;
  return result;
}

export function warnOnUnsafeOptions(options: Record<string, unknown>, cwd: string): void {
  const inactivity = typeof options.timeoutMs === "number" ? options.timeoutMs : 30 * 60 * 1000;
  const maximum = typeof options.maxDurationMs === "number" ? options.maxDurationMs : 2 * 60 * 60 * 1000;
  if (Number.isFinite(inactivity) && Number.isFinite(maximum) && maximum < inactivity) {
    warn("Qoder maxDurationMs is shorter than timeoutMs; the absolute limit will win");
  }
  if (options.permissionMode === "bypassPermissions") {
    warn("Qoder bypassPermissions is enabled; review this workspace before allowing model actions");
  }
  if (options.sessionPersistence === true && typeof options.sessionKey !== "string") {
    warn("Qoder sessionPersistence is enabled without a sessionKey; persistence will be unavailable");
  }
  try {
    if (!existsSync(resolve(cwd))) warn(`Qoder workspace does not exist: ${cwd}`);
  } catch {
    warn(`Qoder workspace could not be validated: ${cwd}`);
  }
}

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
export function normalizeBridgeSettings(input: BridgeSettingsInput): NormalizedBridgeSettings {
  const merged: Record<string, unknown> = { ...input.existing };
  if (input.workspaceCwd && (typeof merged.cwd !== "string" || !merged.cwd.trim())) {
    merged.cwd = input.workspaceCwd;
  }
  const bridged = input.mcpServers ?? {};
  if (Object.keys(bridged).length > 0) {
    merged.mcpServers = { ...(isRecord(merged.mcpServers) ? merged.mcpServers : {}), ...bridged };
  }
  const cwd = typeof merged.cwd === "string" && merged.cwd.trim() ? merged.cwd : process.cwd();
  warnOnUnsafeOptions(merged, cwd);
  return {
    settings: merged as QoderBridgeOptions,
    cwd,
    sessionKey: typeof merged.sessionKey === "string" ? merged.sessionKey : undefined,
    sessionId: typeof merged.sessionId === "string" ? merged.sessionId : undefined,
    environment: discoveryEnvironment(merged.env),
    discovery: discoveryOptions(merged),
  };
}
