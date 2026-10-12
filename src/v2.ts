import { Model, Plugin, Provider } from "@opencode/plugin";
import type { Credential } from "@opencode/plugin";
import type { IntegrationOAuthAuthorization } from "@opencode/plugin/promise/integration";
import { z } from "zod";
import { isRecord, normalizeBridgeSettings } from "./bridge-options.js";
import type { NormalizedBridgeSettings } from "./bridge-options.js";
import { qoderDeviceSignIn, refreshQoderJobToken } from "./device-sign-in.js";
import { QoderAuthError } from "./errors.js";
import { debug, describeError, isDebugEnabled, warn } from "./logger.js";
import { bridgeMcpServersV2 } from "./mcp-bridge.js";
import { FALLBACK_MODELS, fetchDynamicModels, getCachedDynamicModels } from "./models.js";
import type { DynamicModelEntry } from "./models.js";
import { writeStoredBrowserCredential } from "./opencode-auth-store.js";
import { configureBrowserAuth, QODER_PAT_ENV } from "./sdk-auth.js";
import type { BrowserCredential } from "./sdk-auth.js";
import { createQoderToolSpecs } from "./tools.js";
import type { PendingMcpAuth, QoderCommandContext } from "./command-actions.js";
import { QoderLanguageModel } from "./language-model.js";

const AI_SDK_PROVIDER_PACKAGE = "aisdk:@ai-sdk/openai-compatible";
const PROVIDER_ID = "qoder";
const INTEGRATION_ID = "qoder";
const OAUTH_METHOD_ID = "oauth";
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Money amounts are branded in the schema; the bridge already prices in USD/M. */
type ModelCost = Model.Info["cost"][number];
const usd = (value: number): ModelCost["input"] => value as ModelCost["input"];

interface NormalizedModel {
  readonly id: string;
  readonly name: string;
  readonly attachment: boolean;
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  readonly limit: { context: number; output: number };
}

function normalizeModel(entry: {
  id: string;
  name: string;
  attachment: boolean;
  reasoning: boolean;
  toolCall: boolean;
  limit: { context: number; output: number };
  cost: Record<string, number>;
}): NormalizedModel {
  return {
    id: entry.id,
    name: entry.name,
    attachment: entry.attachment,
    reasoning: entry.reasoning,
    toolCall: entry.toolCall,
    limit: entry.limit,
    cost: {
      input: entry.cost.input,
      output: entry.cost.output,
      cacheRead: entry.cost.cacheRead ?? entry.cost.cache_read ?? 0,
      cacheWrite: entry.cost.cacheWrite ?? entry.cost.cache_write ?? 0,
    },
  };
}

function toModelInfo(providerID: Provider.ID, model: NormalizedModel): Model.Info {
  return {
    ...Model.Info.default(providerID, Model.ID.make(model.id)),
    name: model.name as Model.Info["name"],
    limit: { context: model.limit.context, output: model.limit.output },
    cost: [{
      input: usd(model.cost.input),
      output: usd(model.cost.output),
      cache: { read: usd(model.cost.cacheRead), write: usd(model.cost.cacheWrite) },
    }],
    capabilities: {
      tools: model.toolCall,
      input: model.attachment ? ["text", "image"] : ["text"],
      output: ["text"],
    },
  };
}

/**
 * Merge the live catalog over the static fallback, exactly as the OpenCode 1
 * `config` hook did, so both versions expose the same inventory.
 */
function mergeModels(
  dynamic: DynamicModelEntry[] | null,
): NormalizedModel[] {
  const merged = new Map<string, NormalizedModel>();
  for (const model of dynamic ?? []) {
    if (UNSAFE_KEYS.has(model.id)) continue;
    merged.set(model.id, normalizeModel(model));
  }
  for (const model of FALLBACK_MODELS) {
    if (UNSAFE_KEYS.has(model.id) || merged.has(model.id)) continue;
    merged.set(model.id, normalizeModel(model));
  }
  return [...merged.values()];
}

type Registration = { dispose: () => Promise<void> | void };

/**
 * OpenCode 2 entry point. OpenCode 1 keeps using the `server` hook in
 * `index.ts`; this module only runs when OpenCode 2 loads the package.
 */
export async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup | void> {
  if (isDebugEnabled()) debug("Plugin initializing (OpenCode 2)");
  const workspaceCwd = typeof ctx.location.directory === "string" && ctx.location.directory.trim()
    ? ctx.location.directory
    : undefined;

  const pendingMcpAuth = new Map<string, PendingMcpAuth>();
  const registrations: Registration[] = [];
  let disposed = false;
  const track = async (registration: Promise<Registration>): Promise<void> => {
    registrations.push(await registration);
  };

  let mcpServers: Record<string, unknown> = {};
  let configuredSettings: Record<string, unknown> = {};
  let resolved: NormalizedBridgeSettings | undefined;

  const commandContext = (): QoderCommandContext => {
    const settings = resolved;
    return {
      configuredCwd: settings?.cwd ?? workspaceCwd ?? process.cwd(),
      ...(settings?.sessionKey ? { configuredSessionKey: settings.sessionKey } : {}),
      ...(settings?.sessionId ? { configuredSessionId: settings.sessionId } : {}),
      configuredBridgeOptions: settings?.settings ?? {},
      ...(settings ? { modelEnvironment: settings.environment, modelOptions: settings.discovery } : {}),
      pendingMcpAuth,
    };
  };

  // Capture the MCP servers OpenCode resolved from the user's config before the
  // provider publishes settings; the Qoder SDK needs them to expose them to the
  // agent. OpenCode 2 owns MCP lifecycle for the host, the bridge only mirrors.
  await track(ctx.mcp.transform((editor) => {
    mcpServers = bridgeMcpServersV2(editor.list());
  }));

  // Capture the user's `providers.qoder.settings` so live model discovery uses
  // the same proxy, VPC, and working directory as chat sessions.
  await track(ctx.provider.transform((editor) => {
    const settings = editor.get(PROVIDER_ID)?.provider.settings;
    configuredSettings = isRecord(settings) ? { ...settings } : {};
  }));
  // Registry reads replay every registered transform; force one so both
  // captures above are populated before the asynchronous discovery below.
  await ctx.mcp.list().catch(() => undefined);
  await ctx.provider.list().catch(() => undefined);

  resolved = normalizeBridgeSettings({
    existing: { ...ctx.options, ...configuredSettings },
    ...(workspaceCwd ? { workspaceCwd } : {}),
    mcpServers,
  });

  await bindBrowserAuth(ctx);

  // Publish the cached/fallback catalog immediately. Live discovery can take
  // several seconds on a cold start, so it runs after setup and updates the
  // provider registry when the account catalog arrives.
  let models = mergeModels(getCachedDynamicModels(resolved.environment, resolved.discovery));

  const providerID = Provider.ID.make(PROVIDER_ID);
  await track(ctx.provider.transform((editor) => {
    const info = {
      ...Provider.Info.empty(providerID),
      name: "Qoder",
      activation: "enabled" as const,
      package: AI_SDK_PROVIDER_PACKAGE,
      // The OpenAI-compatible provider is only the V2 AI SDK adapter. The
      // language hook below replaces its model before inference with the Qoder
      // Agent SDK model. A base URL is required to construct the adapter.
      settings: {
        ...resolved!.settings,
        baseURL: "https://openapi.qoder.sh",
      } as unknown as Provider.Info["settings"],
    };
    const existing = editor.get(PROVIDER_ID);
    if (existing) {
      editor.update(PROVIDER_ID, (draft) => {
        draft.name ||= info.name;
        draft.activation = info.activation;
        draft.package = info.package;
        draft.settings = info.settings;
      });
      editor.models.set(PROVIDER_ID, models.map((model) => toModelInfo(providerID, model)));
      return;
    }
    editor.add({ info, models: models.map((model) => toModelInfo(providerID, model)) });
  }));
  // Replay the transform once now so the fallback catalog is ready before
  // OpenCode finishes plugin setup.
  await ctx.provider.list().catch(() => undefined);

  await track(ctx.aisdk.hook("language", (event) => {
    if (event.model.providerID !== PROVIDER_ID) return;
    const modelSettings = normalizeBridgeSettings({
      existing: { ...configuredSettings, ...event.options },
      ...(workspaceCwd ? { workspaceCwd } : {}),
      mcpServers,
    });
    event.language = new QoderLanguageModel(event.model.modelID, modelSettings.settings);
  }, { providerID: PROVIDER_ID }));

  await track(ctx.tool.transform((editor) => {
    for (const spec of createQoderToolSpecs(commandContext)) {
      editor.add({
        name: spec.name,
        description: spec.description,
        input: z.object(spec.args) as never,
        execute: async (input: never) => {
          try {
            const result = await spec.execute(input as never, commandContext());
            return {
              content: result.output,
              metadata: { title: result.title, ...(result.variant ? { variant: result.variant } : {}) },
            };
          } catch (error) {
            warn(`Qoder ${spec.name} failed:`, error);
            return { content: `Qoder ${spec.name} failed: ${describeError(error)}` };
          }
        },
      } as never);
    }
  }));

  await track(ctx.integration.transform((editor) => {
    // Register the integration itself before attaching its auth methods. The
    // OpenCode 2 login picker discovers integrations, not provider auth hooks.
    editor.update(INTEGRATION_ID, (integration) => {
      integration.name = "Qoder (opencode-qoder-bridge)";
    });
    editor.method.update({
      integrationID: INTEGRATION_ID,
      method: { id: OAUTH_METHOD_ID, type: "oauth", label: "Sign in with Qoder via opencode-qoder-bridge" },
      authorize: async () => {
        const integration = await ctx.integration.get({ integrationID: INTEGRATION_ID });
        const existing = integration.data.connections.find((connection) => connection.type === "credential");
        if (existing) {
          throw new QoderAuthError(
            `Qoder is already connected as ${existing.label}. Remove that account first to keep only one Qoder user.`,
          );
        }
        return authorizeQoder();
      },
      refresh: refreshQoderCredential,
      label: qoderCredentialLabel,
    });
    if (resolved?.settings.disableQoderCliLogin !== true) {
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "env", names: [QODER_PAT_ENV] },
      });
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: "cli",
          type: "command",
          label: `Use ${QODER_PAT_ENV} or run qoder login in your terminal (CN region: the CN CLI login)`,
          command: ["qoder", "login"],
        },
      });
    }
  }));

  const events = new AbortController();
  const stream = await Promise.resolve(ctx.event.subscribe({ signal: events.signal }) as unknown);
  void (async () => {
    try {
      for await (const event of stream as AsyncIterable<{ type?: string }>) {
        if (event?.type === "credential.updated" || event?.type === "credential.switched") {
          await bindBrowserAuth(ctx);
        }
      }
    } catch (error) {
      if (!events.signal.aborted) debug("Qoder event subscription stopped:", describeError(error));
    }
  })();

  // Refresh in the background. `provider.list()` replays transforms, so the
  // mutable `models` catalog is published as soon as discovery succeeds.
  void (async () => {
    try {
      const refreshed = await fetchDynamicModels(true, resolved!.environment, resolved!.discovery);
      if (!refreshed || disposed) return;
      const nextModels = mergeModels(refreshed);
      if (JSON.stringify(nextModels) === JSON.stringify(models)) return;
      models = nextModels;
      await ctx.provider.list();
    } catch (error) {
      if (!disposed) debug("Background model discovery unavailable; keeping cached/fallback models:", describeError(error));
    }
  })();

  return async () => {
    disposed = true;
    events.abort();
    for (const registration of registrations.splice(0)) {
      try {
        await registration.dispose();
      } catch (error) {
        warn("Could not dispose a Qoder registration:", error);
      }
    }
    configureBrowserAuth(null);
  };
}

/**
 * Wire the saved Qoder sign-in into the SDK's browser credential flow. OpenCode
 * 2 owns the credential through the integration connection; the bridge only
 * keeps a rotating in-memory copy so token refreshes stay in sync.
 */
async function bindBrowserAuth(ctx: Plugin.Context): Promise<void> {
  try {
    const connection = await ctx.integration.connection.active(INTEGRATION_ID);
    const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
    if (credential?.type !== "oauth") {
      // Fall back to the on-disk auth store so a CLI login still works.
      configureBrowserAuth(null);
      return;
    }
    const metadata = isRecord(credential.metadata) ? credential.metadata : {};
    const accountId = typeof metadata.accountId === "string" ? metadata.accountId : undefined;
    let current: BrowserCredential = {
      type: "oauth",
      access: credential.access,
      refresh: credential.refresh,
      expires: credential.expires,
      ...(accountId ? { accountId } : {}),
    };
    configureBrowserAuth({
      accountId,
      read: async () => current,
      write: async (updated, previous) => {
        current = updated;
        try {
          await writeStoredBrowserCredential(updated, previous);
        } catch {
          // The host may keep its own credential store; the rotation is still
          // applied in memory so the next request uses the fresh access token.
        }
      },
    });
  } catch (error) {
    debug("Could not bind the Qoder integration credential:", describeError(error));
    configureBrowserAuth(null);
  }
}

/** OpenCode 2 asks integrations to run the browser device flow. */
async function authorizeQoder(): Promise<IntegrationOAuthAuthorization> {
  const result = await qoderDeviceSignIn();
  return {
    url: result.url,
    instructions: result.instructions,
    mode: "auto",
    callback: (async () => {
      if (result.method !== "auto") throw new QoderAuthError("Qoder browser sign-in is unavailable in this mode.");
      const granted = await result.callback();
      if (granted.type !== "success" || !("access" in granted)) {
        throw new QoderAuthError("Qoder browser sign-in was not completed.");
      }
      return toOAuthCredential(granted);
    })(),
  };
}

function qoderCredentialLabel(credential: Credential.OAuth): string {
  const metadata = isRecord(credential.metadata) ? credential.metadata : {};
  const accountId = typeof metadata.accountId === "string"
    ? metadata.accountId.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 120)
    : "";
  return accountId
    ? `${accountId} (opencode-qoder-bridge)`
    : "Qoder account (opencode-qoder-bridge)";
}

async function refreshQoderCredential(credential: Credential.OAuth): Promise<Credential.OAuth> {
  const renewed = await refreshQoderJobToken(credential.refresh, AbortSignal.timeout(20_000));
  return { ...credential, access: renewed.access, refresh: renewed.refresh, expires: renewed.expires };
}

function toOAuthCredential(granted: {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}): Credential.OAuth {
  return {
    type: "oauth",
    methodID: OAUTH_METHOD_ID as unknown as Credential.OAuth["methodID"],
    access: granted.access,
    refresh: granted.refresh,
    expires: granted.expires,
    ...(granted.accountId ? { metadata: { accountId: granted.accountId } } : {}),
  };
}
