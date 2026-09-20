import { type Hooks, type Config, type Plugin, tool } from "@opencode-ai/plugin";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { FALLBACK_MODELS, fetchDynamicModels, getCachedDynamicModels } from "./models.js";
import type { DynamicModelEntry, ModelDiscoveryOptions } from "./models.js";
import { hasQoderCredential, QODER_PAT_ENV } from "./sdk-auth.js";
import { bridgeMcpServers } from "./mcp-bridge.js";
import { ensureTuiRegistered } from "./tui-register.js";
import { debug, describeError, isDebugEnabled, warn } from "./logger.js";
import { mergedEnvironment } from "./environment.js";
import {
  runQoderMcpAuth,
  runQoderMcpStatus,
  runQoderModels,
  runQoderPlanMode,
  runQoderSessionFork,
  runQoderSessionReset,
  runQoderSessions,
  runQoderUsage,
} from "./command-actions.js";
import type { PendingMcpAuth, QoderCommandContext } from "./command-actions.js";
import type { QoderBridgeOptions } from "./types.js";

const PROVIDER_URL = new URL("./provider.js", import.meta.url).href;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MODEL_STARTUP_DISCOVERY_TIMEOUT_MS = 10_000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeDisplay(value: unknown, fallback: string, maxLength = 512): string {
  if (typeof value !== "string" || !value) return fallback;
  const clean = value.replace(CONTROL_CHARS, " ").slice(0, maxLength);
  return clean || fallback;
}

function discoveryEnvironment(value: unknown): Record<string, string | undefined> {
  return isRecord(value) ? mergedEnvironment(value as Record<string, string | undefined>) : mergedEnvironment();
}

function discoveryOptions(options: Record<string, unknown>): ModelDiscoveryOptions {
  const result: ModelDiscoveryOptions = { timeoutMs: MODEL_STARTUP_DISCOVERY_TIMEOUT_MS };
  if (typeof options.proxy === "string" && options.proxy.trim()) result.proxy = options.proxy;
  if (typeof options.vpcEndpoint === "string" && options.vpcEndpoint.trim()) result.vpcEndpoint = options.vpcEndpoint;
  if (typeof options.cwd === "string" && options.cwd.trim()) result.cwd = options.cwd;
  return result;
}

function warnOnUnsafeOptions(options: Record<string, unknown>, cwd: string): void {
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

function buildFallbackEntry(m: (typeof FALLBACK_MODELS)[number]) {
  return {
    name: m.name,
    attachment: m.attachment,
    reasoning: m.reasoning,
    temperature: false,
    tool_call: m.toolCall,
    limit: { context: m.limit.context, output: m.limit.output },
    cost: {
      input: m.cost.input,
      output: m.cost.output,
      cache_read: m.cost.cacheRead,
      cache_write: m.cost.cacheWrite,
    },
    modalities: {
      input: m.attachment ? ["text", "image"] : ["text"],
      output: ["text"],
    },
  };
}

function buildDynamicEntry(m: DynamicModelEntry) {
  return {
    name: m.name,
    attachment: m.attachment,
    reasoning: m.reasoning,
    temperature: false,
    tool_call: m.toolCall,
    limit: m.limit,
    cost: m.cost,
    modalities: m.modalities,
  };
}

const plugin: Plugin = async (input): Promise<Hooks> => {
  const workspaceCwd = input && typeof input.directory === "string" && input.directory.trim()
    ? input.directory
    : undefined;
  let configuredSessionKey: string | undefined;
  let configuredSessionId: string | undefined;
  let configuredCwd = workspaceCwd ?? process.cwd();
  let configuredBridgeOptions: QoderBridgeOptions = {};
  let modelEnvironment: Record<string, string | undefined> = { ...process.env };
  let modelOptions: ModelDiscoveryOptions = { timeoutMs: MODEL_STARTUP_DISCOVERY_TIMEOUT_MS };

  const pendingMcpAuth = new Map<string, PendingMcpAuth>();

  const commandContext = (): QoderCommandContext => ({
    configuredCwd,
    ...(configuredSessionKey ? { configuredSessionKey } : {}),
    ...(configuredSessionId ? { configuredSessionId } : {}),
    configuredBridgeOptions,
    modelEnvironment,
    modelOptions,
    pendingMcpAuth,
  });

  if (input) {
    if (isDebugEnabled()) debug("Plugin initializing");
    try {
      const result = await ensureTuiRegistered();
      if (result === "added") {
        console.info("[opencode-qoder-bridge] Registered Qoder sidebar; restart OpenCode to activate it.");
      }
    } catch (error) {
      warn("Could not register Qoder sidebar:", error);
    }
  }

  return {
    async config(config: Config) {
      config.provider ??= {};
      const existing = isRecord(config.provider.qoder) ? config.provider.qoder : {};
      const existingOptions = isRecord(existing.options) ? existing.options : {};
      const environment = discoveryEnvironment(existingOptions.env);
      const discoveryConfig = discoveryOptions(existingOptions);
      modelEnvironment = environment;
      modelOptions = discoveryConfig;

      // OpenCode snapshots provider models while this hook runs. Complete one
      // bounded live discovery before returning so a fresh install exposes the
      // current account catalog immediately; retain cache/fallback behavior if
      // Qoder is offline, unauthenticated, or slower than the startup budget.
      let dynamic = getCachedDynamicModels(environment, discoveryConfig);
      try {
        const refreshed = await fetchDynamicModels(true, environment, discoveryConfig);
        if (refreshed) dynamic = refreshed;
      } catch (error) {
        debug("Startup model discovery unavailable; using cached/fallback models:", describeError(error));
      }

      const builtinModels: Record<string, unknown> = {};
      if (dynamic) {
        for (const m of dynamic) {
          if (!UNSAFE_KEYS.has(m.id)) builtinModels[m.id] = buildDynamicEntry(m);
        }
      }
      // Keep the provider usable when the live catalog is partial or offline.
      // Dynamic entries remain authoritative for IDs returned by the SDK.
      for (const m of FALLBACK_MODELS) {
        if (!UNSAFE_KEYS.has(m.id) && !builtinModels[m.id]) builtinModels[m.id] = buildFallbackEntry(m);
      }
      const existingModels = isRecord(existing.models) ? existing.models : {};
      const mergedModels = { ...builtinModels, ...existingModels };

      const bridgedMcp = bridgeMcpServers((config as Record<string, unknown>).mcp);
      const mergedOptions: Record<string, unknown> = { ...existingOptions };
      if (workspaceCwd && (typeof mergedOptions.cwd !== "string" || !mergedOptions.cwd.trim())) {
        mergedOptions.cwd = workspaceCwd;
      }
      if (typeof mergedOptions.cwd === "string" && mergedOptions.cwd.trim()) configuredCwd = mergedOptions.cwd;
      configuredSessionKey = typeof mergedOptions.sessionKey === "string" ? mergedOptions.sessionKey : undefined;
      configuredSessionId = typeof mergedOptions.sessionId === "string" ? mergedOptions.sessionId : undefined;
      warnOnUnsafeOptions(mergedOptions, configuredCwd);
      if (Object.keys(bridgedMcp).length > 0) {
        mergedOptions.mcpServers = {
          ...(isRecord(existingOptions.mcpServers) ? existingOptions.mcpServers : {}),
          ...bridgedMcp,
        };
      }
      configuredBridgeOptions = mergedOptions as QoderBridgeOptions;

      config.provider.qoder = {
        ...existing,
        npm: existing.npm ?? PROVIDER_URL,
        name: existing.name ?? "Qoder",
        options: mergedOptions,
        models: mergedModels,
      } as Config["provider"] extends infer T ? T[keyof T] : never;
    },

    auth: {
      provider: "qoder",
      async loader() {
        return {};
      },
      methods: [
        {
          type: "api",
          label: `Use ${QODER_PAT_ENV} or run qoder login in your terminal`,
          prompts: [],
          async authorize() {
            if (!hasQoderCredential()) {
              warn(
                "Authorize failed: no usable Qoder credential found.",
                `Run qoder login or set ${QODER_PAT_ENV}, then retry.`,
              );
              return { type: "failed" };
            }
            return { type: "success", key: "qoder-cli-auth" };
          },
        },
      ],
    },

    tool: {
      qoder_usage: tool({
        description:
          "Show Qoder account usage and quota (live), plus accumulated session cost and token totals from the local ledger.",
        args: {},
        async execute() {
          return runQoderUsage(commandContext());
        },
      }),
      qoder_models: tool({
        description: "List known Qoder models, capabilities, limits, and price multipliers.",
        args: {},
        async execute() {
          return runQoderModels(commandContext());
        },
      }),
      qoder_session_reset: tool({
        description: "Forget the persisted Qoder session mapping for a key, or use 'all' to reset all sessions.",
        args: {
          key: tool.schema.string().optional().describe("Session key to reset, or 'all' to clear all persisted sessions (defaults to configured sessionKey)."),
        },
        async execute(args) {
          return runQoderSessionReset(commandContext(), args.key);
        },
      }),
      qoder_sessions: tool({
        description: "List recent Qoder sessions with metadata (session ID, title, branch, last modified).",
        args: {
          dir: tool.schema.string().optional().describe("Working directory / project path to filter sessions (optional)."),
          limit: tool.schema.number().optional().describe("Maximum number of sessions to return (optional, default: 10)."),
        },
        async execute(args) {
          return runQoderSessions(commandContext(), args);
        },
      }),
      qoder_session_fork: tool({
        description: "Fork a persisted Qoder session into a new independent session without changing the active session mapping.",
        args: {
          sessionId: tool.schema.string().optional().describe("Source Qoder session ID (defaults to the configured/resumed session)."),
          dir: tool.schema.string().optional().describe("Working directory containing the session transcript (optional, defaults to the active project)."),
          title: tool.schema.string().optional().describe("Optional title for the fork."),
          upToMessageId: tool.schema.string().optional().describe("Optional transcript message UUID; fork only the history through this message."),
        },
        async execute(args) {
          return runQoderSessionFork(commandContext(), args);
        },
      }),
      qoder_mcp_status: tool({
        description: "Inspect Qoder MCP server connection and OAuth status without sending a model turn.",
        args: {},
        async execute() {
          return runQoderMcpStatus(commandContext());
        },
      }),
      qoder_mcp_auth: tool({
        description: "Start or complete OAuth authentication for a configured Qoder MCP server.",
        args: {
          server: tool.schema.string().describe("Configured MCP server name."),
          callbackUrl: tool.schema.string().optional().describe("OAuth callback URL copied after authorizing (omit to start the flow)."),
          redirectUri: tool.schema.string().optional().describe("Optional redirect URI to use when starting OAuth."),
        },
        async execute(args) {
          return runQoderMcpAuth(commandContext(), args);
        },
      }),
      qoder_plan_mode: tool({
        description: "Explain Qoder Plan Mode status and configuration in OpenCode.",
        args: {},
        async execute() {
          return runQoderPlanMode();
        },
      }),
    },
  };
};

export default plugin;
