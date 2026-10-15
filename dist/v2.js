import { Model, Plugin, Provider } from "@opencode/plugin";
import { z } from "zod";
import { isRecord, normalizeBridgeSettings } from "./bridge-options.js";
import { decodeRefreshToken, qoderDeviceSignIn, refreshQoderBrowserToken } from "./device-sign-in.js";
import { QoderAuthError } from "./errors.js";
import { debug, describeError, isDebugEnabled, warn } from "./logger.js";
import { bridgeMcpServersV2 } from "./mcp-bridge.js";
import { FALLBACK_MODELS, fetchDynamicModels, getCachedDynamicModels } from "./models.js";
import { writeStoredBrowserCredential } from "./opencode-auth-store.js";
import { browserAuthVpcEndpoint, configureBrowserAuth, QODER_PAT_ENV } from "./sdk-auth.js";
import { createQoderToolSpecs } from "./tools.js";
import { QoderLanguageModel } from "./language-model.js";
import { normalizeCnVpcEndpoint } from "./cn-vpc.js";
const AI_SDK_PROVIDER_PACKAGE = "aisdk:@ai-sdk/openai-compatible";
const PROVIDER_ID = "qoder";
const INTEGRATION_ID = "qoder";
const OAUTH_METHOD_ID = "oauth";
const OAUTH_CN_METHOD_ID = "oauth-cn";
const OAUTH_CN_VPC_METHOD_ID = "oauth-cn-vpc";
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const usd = (value) => value;
function normalizeModel(entry) {
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
function toModelInfo(providerID, model) {
    return {
        ...Model.Info.default(providerID, Model.ID.make(model.id)),
        name: model.name,
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
function mergeModels(dynamic) {
    const merged = new Map();
    for (const model of dynamic ?? []) {
        if (UNSAFE_KEYS.has(model.id))
            continue;
        merged.set(model.id, normalizeModel(model));
    }
    for (const model of FALLBACK_MODELS) {
        if (UNSAFE_KEYS.has(model.id) || merged.has(model.id))
            continue;
        merged.set(model.id, normalizeModel(model));
    }
    return [...merged.values()];
}
/**
 * OpenCode 2 entry point. OpenCode 1 keeps using the `server` hook in
 * `index.ts`; this module only runs when OpenCode 2 loads the package.
 */
export async function setup(ctx) {
    if (isDebugEnabled())
        debug("Plugin initializing (OpenCode 2)");
    const workspaceCwd = typeof ctx.location.directory === "string" && ctx.location.directory.trim()
        ? ctx.location.directory
        : undefined;
    const pendingMcpAuth = new Map();
    const registrations = [];
    let disposed = false;
    const track = async (registration) => {
        registrations.push(await registration);
    };
    let mcpServers = {};
    let configuredSettings = {};
    let resolved;
    const commandContext = () => {
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
    const modelDiscovery = {
        ...resolved.discovery,
        ...(browserAuthVpcEndpoint() ? { vpcEndpoint: browserAuthVpcEndpoint() } : {}),
    };
    let models = mergeModels(getCachedDynamicModels(resolved.environment, modelDiscovery));
    const providerID = Provider.ID.make(PROVIDER_ID);
    await track(ctx.provider.transform((editor) => {
        const info = {
            ...Provider.Info.empty(providerID),
            name: "Qoder",
            activation: "enabled",
            package: AI_SDK_PROVIDER_PACKAGE,
            // The OpenAI-compatible provider is only the V2 AI SDK adapter. The
            // language hook below replaces its model before inference with the Qoder
            // Agent SDK model. A base URL is required to construct the adapter.
            settings: {
                ...resolved.settings,
                baseURL: "https://openapi.qoder.sh",
            },
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
        if (event.model.providerID !== PROVIDER_ID)
            return;
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
                input: z.object(spec.args),
                execute: async (input) => {
                    try {
                        const result = await spec.execute(input, commandContext());
                        return {
                            content: result.output,
                            metadata: { title: result.title, ...(result.variant ? { variant: result.variant } : {}) },
                        };
                    }
                    catch (error) {
                        warn(`Qoder ${spec.name} failed:`, error);
                        return { content: `Qoder ${spec.name} failed: ${describeError(error)}` };
                    }
                },
            });
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
                    throw new QoderAuthError(`Qoder is already connected as ${existing.label}. Remove that account first to keep only one Qoder user.`);
                }
                return authorizeQoder("global");
            },
            refresh: refreshQoderCredential,
            label: qoderCredentialLabel,
        });
        editor.method.update({
            integrationID: INTEGRATION_ID,
            method: { id: OAUTH_CN_METHOD_ID, type: "oauth", label: "Sign in with Qoder CN via opencode-qoder-bridge" },
            authorize: async () => {
                const integration = await ctx.integration.get({ integrationID: INTEGRATION_ID });
                const existing = integration.data.connections.find((connection) => connection.type === "credential");
                if (existing) {
                    throw new QoderAuthError(`Qoder is already connected as ${existing.label}. Remove that account first to keep only one Qoder user.`);
                }
                return authorizeQoder("cn");
            },
            refresh: refreshQoderCredential,
            label: qoderCredentialLabel,
        });
        editor.method.update({
            integrationID: INTEGRATION_ID,
            method: {
                id: OAUTH_CN_VPC_METHOD_ID,
                type: "oauth",
                label: "Sign in with Qoder CN Enterprise (VPC)",
                form: [{
                        key: "vpc",
                        type: "string",
                        title: "Enterprise VPC instance",
                        description: "Enter the instance name (for example, acme) or its HTTPS address under vpc.qoder.com.cn.",
                        placeholder: "acme",
                        required: true,
                    }],
            },
            authorize: async (answer) => {
                const integration = await ctx.integration.get({ integrationID: INTEGRATION_ID });
                const existing = integration.data.connections.find((connection) => connection.type === "credential");
                if (existing)
                    throw new QoderAuthError(`Qoder is already connected as ${existing.label}. Remove that account first to keep only one Qoder user.`);
                const endpoint = normalizeCnVpcEndpoint(answer.vpc);
                if (!endpoint)
                    throw new QoderAuthError("Enter a valid Qoder CN enterprise VPC instance name or HTTPS address.");
                return authorizeQoder("cn", endpoint);
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
    const stream = await Promise.resolve(ctx.event.subscribe({ signal: events.signal }));
    void (async () => {
        try {
            for await (const event of stream) {
                if (event?.type === "credential.updated" || event?.type === "credential.switched") {
                    await bindBrowserAuth(ctx);
                }
            }
        }
        catch (error) {
            if (!events.signal.aborted)
                debug("Qoder event subscription stopped:", describeError(error));
        }
    })();
    // Refresh in the background. `provider.list()` replays transforms, so the
    // mutable `models` catalog is published as soon as discovery succeeds.
    void (async () => {
        try {
            const refreshed = await fetchDynamicModels(true, resolved.environment, {
                ...resolved.discovery,
                ...(browserAuthVpcEndpoint() ? { vpcEndpoint: browserAuthVpcEndpoint() } : {}),
            });
            if (!refreshed || disposed)
                return;
            const nextModels = mergeModels(refreshed);
            if (JSON.stringify(nextModels) === JSON.stringify(models))
                return;
            models = nextModels;
            await ctx.provider.list();
        }
        catch (error) {
            if (!disposed)
                debug("Background model discovery unavailable; keeping cached/fallback models:", describeError(error));
        }
    })();
    return async () => {
        disposed = true;
        events.abort();
        for (const registration of registrations.splice(0)) {
            try {
                await registration.dispose();
            }
            catch (error) {
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
async function bindBrowserAuth(ctx) {
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
        const region = metadata.region === "cn" || metadata.region === "global"
            ? metadata.region
            : decodeRefreshToken(credential.refresh).region;
        const vpcEndpoint = (typeof metadata.vpcEndpoint === "string" ? normalizeCnVpcEndpoint(metadata.vpcEndpoint) : undefined)
            ?? decodeRefreshToken(credential.refresh).vpcEndpoint;
        let current = {
            type: "oauth",
            access: credential.access,
            refresh: credential.refresh,
            expires: credential.expires,
            ...(accountId ? { accountId } : {}),
        };
        configureBrowserAuth({
            accountId,
            region,
            vpcEndpoint,
            read: async () => current,
            write: async (updated, previous) => {
                current = updated;
                try {
                    await writeStoredBrowserCredential(updated, previous);
                }
                catch {
                    // The host may keep its own credential store; the rotation is still
                    // applied in memory so the next request uses the fresh access token.
                }
            },
        });
    }
    catch (error) {
        debug("Could not bind the Qoder integration credential:", describeError(error));
        configureBrowserAuth(null);
    }
}
/** OpenCode 2 asks integrations to run the browser device flow. */
async function authorizeQoder(region, vpcEndpoint) {
    const result = await qoderDeviceSignIn({}, region, vpcEndpoint);
    return {
        url: result.url,
        instructions: result.instructions,
        mode: "auto",
        callback: (async () => {
            if (result.method !== "auto")
                throw new QoderAuthError("Qoder browser sign-in is unavailable in this mode.");
            const granted = await result.callback();
            if (granted.type !== "success" || !("access" in granted)) {
                throw new QoderAuthError("Qoder browser sign-in was not completed.");
            }
            return toOAuthCredential(granted, region, vpcEndpoint);
        })(),
    };
}
function qoderCredentialLabel(credential) {
    const metadata = isRecord(credential.metadata) ? credential.metadata : {};
    const credentialRegion = typeof credential.refresh === "string" ? decodeRefreshToken(credential.refresh).region : undefined;
    const accountId = typeof metadata.accountId === "string"
        ? metadata.accountId.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 120)
        : "";
    const region = metadata.region === "cn" || credentialRegion === "cn" ? "Qoder CN" : "Qoder";
    return accountId
        ? `${region}: ${accountId} (opencode-qoder-bridge)`
        : `${region} account (opencode-qoder-bridge)`;
}
async function refreshQoderCredential(credential) {
    const renewed = await refreshQoderBrowserToken(credential.refresh, AbortSignal.timeout(20_000));
    return { ...credential, access: renewed.access, refresh: renewed.refresh, expires: renewed.expires };
}
function toOAuthCredential(granted, region, vpcEndpoint) {
    return {
        type: "oauth",
        methodID: (vpcEndpoint ? OAUTH_CN_VPC_METHOD_ID : region === "cn" ? OAUTH_CN_METHOD_ID : OAUTH_METHOD_ID),
        access: granted.access,
        refresh: granted.refresh,
        expires: granted.expires,
        metadata: { region, ...(vpcEndpoint ? { vpcEndpoint } : {}), ...(granted.accountId ? { accountId: granted.accountId } : {}) },
    };
}
//# sourceMappingURL=v2.js.map