import { type Hooks, type Config, type Plugin, tool } from "@opencode-ai/plugin";
import { FALLBACK_MODELS, fetchDynamicModels, getCachedDynamicModels } from "./models.js";
import type { DynamicModelEntry, ModelDiscoveryOptions } from "./models.js";
import { browserAuthVpcEndpoint, configureBrowserAuth, hasQoderPAT, QODER_PAT_ENV } from "./sdk-auth.js";
import type { BrowserCredential } from "./sdk-auth.js";
import { decodeRefreshToken, qoderDeviceSignIn } from "./device-sign-in.js";
import { normalizeCnVpcEndpoint } from "./cn-vpc.js";
import { cliLoginHint, isAuthenticated } from "./auth.js";
import { bridgeMcpServers } from "./mcp-bridge.js";
import { ensureTuiRegistered } from "./tui-register.js";
import { debug, describeError, isDebugEnabled, warn } from "./logger.js";
import {
  isRecord,
  MODEL_STARTUP_DISCOVERY_TIMEOUT_MS,
  normalizeBridgeSettings,
} from "./bridge-options.js";
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
import type { PendingMcpAuth, QoderCommandContext } from "./command-actions.js";
import type { QoderBridgeOptions } from "./types.js";

const PROVIDER_URL = new URL("./provider.js", import.meta.url).href;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function safeDisplay(value: unknown, fallback: string, maxLength = 512): string {
  if (typeof value !== "string" || !value) return fallback;
  const clean = value.replace(CONTROL_CHARS, " ").slice(0, maxLength);
  return clean || fallback;
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

  const saveBrowserCredential = async (credential: BrowserCredential): Promise<void> => {
    if (!input) throw new Error("OpenCode is required to save Qoder browser credentials");
    const result = await input.client.auth.set({ path: { id: "qoder" }, body: credential });
    if (result.error) throw new Error("OpenCode could not save the refreshed Qoder sign-in");
  };

  const bindBrowserCredential = (
    initial: BrowserCredential,
    read: () => Promise<BrowserCredential | null>,
  ): void => {
    if (!input) return;
    configureBrowserAuth({
      accountId: initial.accountId,
      region: decodeRefreshToken(initial.refresh).region,
      vpcEndpoint: decodeRefreshToken(initial.refresh).vpcEndpoint,
      read,
      write: saveBrowserCredential,
    });
  };

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
      const bridgedMcp = bridgeMcpServers((config as Record<string, unknown>).mcp);
      const normalized = normalizeBridgeSettings({
        existing: existingOptions,
        ...(workspaceCwd ? { workspaceCwd } : {}),
        mcpServers: bridgedMcp,
      });
      modelEnvironment = normalized.environment;
      modelOptions = normalized.discovery;
      configuredCwd = normalized.cwd;
      configuredSessionKey = normalized.sessionKey;
      configuredSessionId = normalized.sessionId;
      configuredBridgeOptions = normalized.settings;

      // OpenCode snapshots provider models while this hook runs. Complete one
      // bounded live discovery before returning so a fresh install exposes the
      // current account catalog immediately; retain cache/fallback behavior if
      // Qoder is offline, unauthenticated, or slower than the startup budget.
      let dynamic = getCachedDynamicModels(modelEnvironment, modelOptions);
      try {
        const refreshed = await fetchDynamicModels(true, modelEnvironment, modelOptions);
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

      config.provider.qoder = {
        ...existing,
        npm: existing.npm ?? PROVIDER_URL,
        name: existing.name ?? "Qoder",
        options: normalized.settings,
        models: mergedModels,
      } as Config["provider"] extends infer T ? T[keyof T] : never;
    },

    auth: {
      provider: "qoder",
      async loader(getAuth) {
        const saved = await getAuth();
        if (saved?.type === "oauth") {
          bindBrowserCredential(saved, async () => {
            const current = await getAuth();
            return current?.type === "oauth" ? current : null;
          });
        } else {
          configureBrowserAuth(null);
        }
        return {};
      },
      methods: [
        {
          type: "oauth",
          label: "Sign in with Qoder in your browser",
          prompts: [{
            type: "select",
            key: "region",
            message: "Qoder region",
            options: [
              { label: "Qoder (qoder.com)", value: "global" },
              { label: "Qoder CN (qoder.cn)", value: "cn" },
            ],
          }],
          authorize: (answers) => qoderDeviceSignIn({}, answers?.region === "cn" ? "cn" : "global"),
        },
        {
          type: "oauth",
          label: "Sign in with Qoder CN Enterprise (VPC)",
          prompts: [{
            type: "text",
            key: "vpc",
            message: "Enterprise VPC instance name or HTTPS address",
            placeholder: "acme or https://acme.vpc.qoder.com.cn",
            validate: (value) => normalizeCnVpcEndpoint(value) ? undefined : "Enter a valid Qoder CN VPC instance name or HTTPS address.",
          }],
          authorize: (answers) => {
            const endpoint = normalizeCnVpcEndpoint(answers?.vpc);
            if (!endpoint) throw new Error("Enter a valid Qoder CN enterprise VPC instance name or HTTPS address.");
            return qoderDeviceSignIn({}, "cn", endpoint);
          },
        },
        {
          type: "api",
          label: `Create a PAT at qoder.com/account/integrations and set ${QODER_PAT_ENV}, or run qoder login`,
          prompts: [],
          async authorize() {
            if (!hasQoderPAT() && !isAuthenticated()) {
              warn(
                "Authorize failed: no usable Qoder credential found.",
                `${cliLoginHint()}, then retry.`,
              );
              return { type: "failed" };
            }
            return { type: "success", key: "qoder-cli-auth" };
          },
        },
      ],
    },

    provider: {
      id: "qoder",
      async models(provider, { auth }) {
        if (auth?.type !== "oauth" || !input) {
          configureBrowserAuth(null);
          return provider.models;
        }
        let current: BrowserCredential = auth;
        // The model hook runs after the config hook, when the saved browser
        // credential is available. Discover the live catalog through the SDK.
        configureBrowserAuth({
          accountId: auth.accountId,
          region: decodeRefreshToken(auth.refresh).region,
          vpcEndpoint: decodeRefreshToken(auth.refresh).vpcEndpoint,
          read: async () => current,
          write: async (credential) => {
            await saveBrowserCredential(credential);
            current = credential;
          },
        });
        const dynamic = await fetchDynamicModels(true, modelEnvironment, {
          ...modelOptions,
          ...(browserAuthVpcEndpoint() ? { vpcEndpoint: browserAuthVpcEndpoint() } : {}),
        });
        if (!dynamic?.length) return provider.models;
        const fallback = provider.models.auto ?? Object.values(provider.models)[0];
        if (!fallback) return provider.models;
        return {
          ...provider.models,
          ...Object.fromEntries(dynamic.map((model) => {
            const previous = provider.models[model.id] ?? fallback;
            return [model.id, {
              ...previous,
              id: model.id,
              name: model.name,
              limit: model.limit,
              cost: {
                input: model.cost.input,
                output: model.cost.output,
                cache: { read: model.cost.cache_read, write: model.cost.cache_write },
              },
              capabilities: {
                ...previous.capabilities,
                reasoning: model.reasoning,
                attachment: model.attachment,
                toolcall: model.toolCall,
              },
            }];
          })),
        };
      },
    },

    tool: {
      qoder_checkin: tool({
        description: "Claim Qoder's daily credits for the browser-signed-in account.",
        args: {},
        async execute() {
          return runQoderCheckin();
        },
      }),
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

/**
 * One entry point serves both plugin generations.
 *
 * OpenCode 1 loads `default.server` (and requires that a module exporting both
 * `server` and `tui` never happens). OpenCode 2 reads `id` plus `setup` and
 * ignores `server`. The V2 implementation is imported lazily so OpenCode 1
 * never evaluates the V2 plugin package.
 */
interface DualEntryPoint {
  readonly id: string;
  readonly setup: (context: unknown) => Promise<unknown>;
  readonly server: Plugin;
}

const entryPoint: DualEntryPoint = {
  id: "opencode-qoder-bridge",
  async setup(context) {
    const v2 = await import("./v2.js");
    return v2.setup(context as Parameters<typeof v2.setup>[0]);
  },
  server: plugin,
};

export default entryPoint;
