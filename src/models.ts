import { query, type ModelInfo } from "@qoder-ai/qoder-agent-sdk";
import type { QoderModelDef } from "./types.js";
import { findQoderCLI } from "./auth.js";
import { idlePrompt } from "./sdk-session.js";
import { hasQoderCredential, qoderAuth } from "./sdk-auth.js";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveStateDir } from "./state-dir.js";
import { debug, describeError } from "./logger.js";
import { closeAsyncIterator, withTimeout } from "./async-utils.js";

const CONTEXT = 200_000;
const OUTPUT = 32_000;
const MAX_MODEL_CACHE_BYTES = 1_000_000;
const MAX_MODEL_TOKENS = 10_000_000;
const MAX_PRICE_FACTOR = 1_000_000;
const MAX_DYNAMIC_MODELS = 512;
const MODEL_CACHE_VERSION = 1;
const FETCH_TIMEOUT_MS = 30_000;
const CLEANUP_GRACE_MS = 5_000;
const MODEL_REFRESH_INTERVAL_MS = 60_000;
const MODEL_RETRY_INTERVAL_MS = 5_000;
const UNSAFE_IDS = new Set(["__proto__", "prototype", "constructor"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function def(
  id: string,
  name: string,
  multiplier: number,
  opts: Partial<Pick<QoderModelDef, "attachment" | "reasoning" | "toolCall">> = {},
): QoderModelDef {
  return {
    id,
    name,
    multiplier,
    attachment: opts.attachment ?? true,
    reasoning: opts.reasoning ?? false,
    toolCall: opts.toolCall ?? true,
    cost: {
      input: multiplier,
      output: multiplier,
      cacheRead: Number((multiplier * 0.1).toFixed(4)),
      cacheWrite: multiplier,
    },
    limit: { context: CONTEXT, output: OUTPUT },
  };
}

export const FALLBACK_MODELS: QoderModelDef[] = [
  def("lite", "Lite (free)", 0, { attachment: false }),
  def("auto", "Auto (1.0x)", 1.0),
  def("performance", "Performance (1.1x)", 1.1),
];

export const DEFAULT_MODEL_ID = "auto";

const MODEL_INDEX = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));
const STATE_DIR = resolveStateDir();

function toModelDef(m: DynamicModelEntry): QoderModelDef {
  return {
    id: m.id,
    name: m.name,
    multiplier: m.cost.input,
    attachment: m.attachment,
    reasoning: m.reasoning,
    toolCall: m.toolCall,
    cost: {
      input: m.cost.input,
      output: m.cost.output,
      cacheRead: m.cost.cache_read,
      cacheWrite: m.cost.cache_write,
    },
    limit: m.limit,
  };
}

function rebuildIndex(models: DynamicModelEntry[]): void {
  MODEL_INDEX.clear();
  for (const model of FALLBACK_MODELS) MODEL_INDEX.set(model.id, model);
  for (const model of models) {
    const def = toModelDef(model);
    MODEL_INDEX.set(model.id, def);
  }
}

export function getModel(
  id: string,
  environment: Record<string, string | undefined> = process.env,
  options: ModelDiscoveryOptions = {},
): QoderModelDef | undefined {
  const runtimeEnvironment = effectiveEnvironment(environment);
  if (hasQoderCredential(runtimeEnvironment)) getCatalogState(runtimeEnvironment, options);
  else if (activeCatalogScope && catalogStates.get(activeCatalogScope)?.liveUpdated) {
    rebuildIndex(catalogStates.get(activeCatalogScope)?.models ?? []);
  } else {
    rebuildIndex([]);
  }
  return MODEL_INDEX.get(id);
}

export interface DynamicModelEntry {
  id: string;
  name: string;
  attachment: boolean;
  reasoning: boolean;
  toolCall: boolean;
  limit: { context: number; output: number };
  cost: { input: number; output: number; cache_read: number; cache_write: number };
  modalities: { input: string[]; output: string[] };
}

export interface ModelDiscoveryOptions {
  /** Effective environment for the SDK runtime. */
  environment?: Record<string, string | undefined>;
  /** SDK proxy and VPC settings, kept in parity with chat sessions. */
  proxy?: string;
  vpcEndpoint?: string;
  cwd?: string;
  /** Host-side deadline for live discovery. */
  timeoutMs?: number;
}

interface CatalogState {
  scope: string;
  cacheFile: string;
  models: DynamicModelEntry[] | null;
  cacheLoaded: boolean;
  inflightFetch: Promise<DynamicModelEntry[] | null> | null;
  requestGeneration: number;
  lastSuccessAt: number;
  lastFailureAt: number;
  pendingModelsToWrite: DynamicModelEntry[] | null;
  activeWritePromise: Promise<void> | null;
  liveUpdated: boolean;
}

const catalogStates = new Map<string, CatalogState>();
let activeCatalogScope: string | undefined;
let modelQueryFactory: typeof query = query;

/** @internal Test seam for deterministic discovery lifecycle coverage. */
export function setModelDiscoveryQueryFactory(factory: typeof query = query): void {
  modelQueryFactory = factory;
}

/**
 * Keep catalog entries that are usable model ids. Disabled entries are
 * dropped; anything else (BYOK, tagged, scene-filtered) stays so the bridge
 * never hides a model the server actually serves.
 */
export function selectEnabledModels(models: unknown): ModelInfo[] {
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const selected: ModelInfo[] = [];
  for (const m of models) {
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const value = (m as { value?: unknown }).value;
    if (typeof value !== "string"
      || value.trim().length === 0
      || value.length > 256
      || UNSAFE_IDS.has(value)
      || CONTROL_CHARS.test(value)
      || (m as { isEnabled?: unknown }).isEnabled === false
      || seen.has(value)) continue;
    seen.add(value);
    selected.push(m as ModelInfo);
    if (selected.length >= MAX_DYNAMIC_MODELS) break;
  }
  return selected;
}

function mapModelInfo(m: ModelInfo): DynamicModelEntry {
  const factor = finiteNonNegative(m.priceFactor, 1.0);
  const context = finitePositiveInteger(m.maxInputTokens, CONTEXT);
  const output = finitePositiveInteger(m.maxOutputTokens, OUTPUT);
  const vl = m.isVl === undefined ? true : m.isVl === true;
  const displayName = typeof m.displayName === "string" && m.displayName.trim()
    ? m.displayName.replace(CONTROL_CHARS, " ").trim().slice(0, 1024)
    : "";
  return {
    id: m.value,
    name: displayName || m.value,
    attachment: vl,
    reasoning: m.isReasoning === true,
    toolCall: true,
    limit: { context, output },
    cost: {
      input: factor,
      output: factor,
      cache_read: Number((factor * 0.1).toFixed(4)),
      cache_write: factor,
    },
    modalities: {
      input: vl ? ["text", "image"] : ["text"],
      output: ["text"],
    },
  };
}

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_PRICE_FACTOR ? value : fallback;
}

function finitePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_MODEL_TOKENS) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function validCachedModel(value: unknown): value is DynamicModelEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  if (typeof model.id !== "string" || model.id.length === 0 || model.id.length > 256 || UNSAFE_IDS.has(model.id) || CONTROL_CHARS.test(model.id)) return false;
  if (typeof model.name !== "string" || model.name.length === 0 || model.name.length > 1024 || CONTROL_CHARS.test(model.name)) return false;
  if (typeof model.attachment !== "boolean" || typeof model.reasoning !== "boolean" || typeof model.toolCall !== "boolean") return false;

  const limit = model.limit;
  if (!limit || typeof limit !== "object" || Array.isArray(limit)) return false;
  const l = limit as Record<string, unknown>;
  if (finitePositiveInteger(l.context, 0) === 0 || finitePositiveInteger(l.output, 0) === 0) return false;

  const cost = model.cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return false;
  const c = cost as Record<string, unknown>;
  if (![c.input, c.output, c.cache_read, c.cache_write].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_PRICE_FACTOR)) return false;

  const modalities = model.modalities;
  if (!modalities || typeof modalities !== "object" || Array.isArray(modalities)) return false;
  const modes = modalities as Record<string, unknown>;
  return [modes.input, modes.output].every(
    (items) => Array.isArray(items)
      && items.length <= 8
      && items.every((item) => typeof item === "string" && item.length <= 64 && !CONTROL_CHARS.test(item)),
  );
}

function cloneModel(model: DynamicModelEntry): DynamicModelEntry {
  return {
    ...model,
    limit: { ...model.limit },
    cost: { ...model.cost },
    modalities: { input: [...model.modalities.input], output: [...model.modalities.output] },
  };
}

function cloneModels(models: DynamicModelEntry[] | null): DynamicModelEntry[] | null {
  return models?.map(cloneModel) ?? null;
}

function effectiveEnvironment(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...process.env, ...environment };
}

function safeOption(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && !CONTROL_CHARS.test(normalized) ? normalized : undefined;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * Model catalogs are account/scene specific. Keep their cache and refresh
 * state isolated without ever putting a credential itself in a path or log.
 */
function catalogScope(environment: Record<string, string | undefined>, options: ModelDiscoveryOptions): string {
  const token = environment.QODER_PERSONAL_ACCESS_TOKEN?.trim();
  const authScope = token
    ? `pat:${fingerprint(token)}`
    : hasQoderCredential(environment) ? "local-login" : "anonymous";
  const parts = [
    `auth=${authScope}`,
    `scene=${environment.QODER_SCENE ?? ""}`,
    `vpc=${safeOption(options.vpcEndpoint) ?? environment.QODER_VPC_ENDPOINT ?? environment.QODERCN_VPC_ENDPOINT ?? ""}`,
    `endpoint=${environment.QODER_API_URL ?? environment.QODER_BASE_URL ?? ""}`,
    `proxy=${safeOption(options.proxy) ?? environment.HTTPS_PROXY ?? environment.HTTP_PROXY ?? ""}`,
  ];
  return fingerprint(parts.join("\u0000"));
}

function cacheFileFor(scope: string): string {
  return join(STATE_DIR, `models.${scope}.json`);
}

function getCatalogState(
  environment: Record<string, string | undefined> = process.env,
  options: ModelDiscoveryOptions = {},
): CatalogState {
  const runtimeEnvironment = effectiveEnvironment(environment);
  const scope = catalogScope(runtimeEnvironment, options);
  let state = catalogStates.get(scope);
  if (!state) {
    state = {
      scope,
      cacheFile: cacheFileFor(scope),
      models: null,
      cacheLoaded: false,
      inflightFetch: null,
      requestGeneration: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      pendingModelsToWrite: null,
      activeWritePromise: null,
      liveUpdated: false,
    };
    catalogStates.set(scope, state);
  }

  if (!state.cacheLoaded) {
    state.cacheLoaded = true;
    const cached = loadCachedModels(state);
    if (cached) state.models = cached;
  }

  if (activeCatalogScope !== scope) {
    activeCatalogScope = scope;
    rebuildIndex(state.models ?? []);
  }
  return state;
}

/**
 * Dynamically apply live model updates received from SDK streaming events
 * (`available_models_update`). Updates the in-memory index and cache file.
 */
export function applyLiveModelUpdates(
  models: unknown,
  environment: Record<string, string | undefined> = process.env,
  options: ModelDiscoveryOptions = {},
): DynamicModelEntry[] {
  const state = getCatalogState(environment, options);
  const enabled = selectEnabledModels(models);
  // Empty SDK events are commonly transient during auth/scene changes. Keep
  // the current in-memory catalog so the model picker does not suddenly lose
  // every account model; a later non-empty snapshot still replaces it.
  if (enabled.length === 0) {
    debug("Live model update was empty; retaining the current catalog");
    return cloneModels(state.models) ?? [];
  }
  const mapped = enabled.map(mapModelInfo);
  state.requestGeneration += 1;
  state.models = mapped;
  state.liveUpdated = true;
  state.lastFailureAt = 0;
  if (mapped.length > 0) {
    state.lastSuccessAt = Date.now();
    void queueModelCacheWriteForState(state, mapped);
  }
  if (activeCatalogScope === state.scope) rebuildIndex(mapped);
  debug(`Live model update: refreshed ${mapped.length} models`);
  return cloneModels(state.models) ?? [];
}

interface ModelCachePayload {
  version: number;
  scope: string;
  fetchedAt: number;
  models: unknown;
}

function loadCachedModels(state: CatalogState): DynamicModelEntry[] | null {
  try {
    if (!existsSync(state.cacheFile)) return null;
    const info = lstatSync(state.cacheFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MODEL_CACHE_BYTES) return null;
    const parsed = JSON.parse(readFileSync(state.cacheFile, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const payload = parsed as Partial<ModelCachePayload>;
    if (payload.version !== MODEL_CACHE_VERSION || payload.scope !== state.scope || !Array.isArray(payload.models)) return null;
    const models = payload.models.filter(validCachedModel).slice(0, MAX_DYNAMIC_MODELS);
    if (models.length === 0) return null;
    return models;
  } catch (error) {
    debug("Model cache unreadable; using fallback catalog:", describeError(error));
    return null;
  }
}

export function listModels(
  environment: Record<string, string | undefined> = process.env,
  options: ModelDiscoveryOptions = {},
): QoderModelDef[] {
  const runtimeEnvironment = effectiveEnvironment(environment);
  if (hasQoderCredential(runtimeEnvironment)) getCatalogState(runtimeEnvironment, options);
  else if (activeCatalogScope && catalogStates.get(activeCatalogScope)?.liveUpdated) {
    rebuildIndex(catalogStates.get(activeCatalogScope)?.models ?? []);
  }
  else rebuildIndex([]);
  return [...MODEL_INDEX.values()].map((m) => ({ ...m, cost: { ...m.cost }, limit: { ...m.limit } }));
}

export function getCachedDynamicModels(
  environment: Record<string, string | undefined> = process.env,
  options: ModelDiscoveryOptions = {},
): DynamicModelEntry[] | null {
  const runtimeEnvironment = effectiveEnvironment(environment);
  if (!hasQoderCredential(runtimeEnvironment)) return null;
  return cloneModels(getCatalogState(runtimeEnvironment, options).models);
}

export async function fetchDynamicModels(
  force = false,
  environment: Record<string, string | undefined> = process.env,
  options: ModelDiscoveryOptions = {},
): Promise<DynamicModelEntry[] | null> {
  const runtimeEnvironment = effectiveEnvironment(environment);
  if (!hasQoderCredential(runtimeEnvironment)) {
    debug("Skipping live model discovery: no Qoder credential is available");
    return null;
  }
  const state = getCatalogState(runtimeEnvironment, options);
  if (state.models && !force) return cloneModels(state.models);
  if (state.inflightFetch) return state.inflightFetch;

  const now = Date.now();
  if (state.lastSuccessAt > 0 && now - state.lastSuccessAt < MODEL_REFRESH_INTERVAL_MS) {
    return cloneModels(state.models);
  }
  if (state.lastFailureAt > 0 && now - state.lastFailureAt < MODEL_RETRY_INTERVAL_MS) {
    return cloneModels(state.models);
  }

  const generation = ++state.requestGeneration;
  const operation = doFetchDynamicModels(state, runtimeEnvironment, options, generation);
  let tracked: Promise<DynamicModelEntry[] | null>;
  tracked = operation.finally(() => {
    if (state.inflightFetch === tracked) state.inflightFetch = null;
  });
  state.inflightFetch = tracked;
  return tracked;
}

async function writeCacheFile(state: CatalogState, models: DynamicModelEntry[]): Promise<void> {
  let temporary: string | undefined;
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    try { chmodSync(STATE_DIR, 0o700); } catch { /* best-effort */ }
    temporary = join(STATE_DIR, `.models.${state.scope}.${process.pid}.${randomUUID()}.tmp`);
    const payload: ModelCachePayload = {
      version: MODEL_CACHE_VERSION,
      scope: state.scope,
      fetchedAt: Date.now(),
      models,
    };
    await writeFile(temporary, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, state.cacheFile);
    temporary = undefined;
  } finally {
    if (temporary) {
      try { unlinkSync(temporary); } catch { /* best-effort */ }
    }
  }
}

async function processCacheWrite(state: CatalogState): Promise<void> {
  while (state.pendingModelsToWrite !== null) {
    const toWrite = state.pendingModelsToWrite;
    state.pendingModelsToWrite = null;
    try {
      await writeCacheFile(state, toWrite);
    } catch (error) {
      debug("Model cache write failed:", describeError(error));
    }
  }
  state.activeWritePromise = null;
}

function queueModelCacheWriteForState(state: CatalogState, models: DynamicModelEntry[]): Promise<void> {
  state.pendingModelsToWrite = models.map(cloneModel);
  state.activeWritePromise ??= processCacheWrite(state);
  return state.activeWritePromise;
}

export function queueModelCacheWrite(
  models: DynamicModelEntry[],
  environment: Record<string, string | undefined> = process.env,
  options: ModelDiscoveryOptions = {},
): Promise<void> {
  return queueModelCacheWriteForState(getCatalogState(environment, options), models);
}

export async function flushModelCache(): Promise<void> {
  const writes = [...catalogStates.values()]
    .map((state) => state.activeWritePromise)
    .filter((promise): promise is Promise<void> => Boolean(promise));
  if (writes.length > 0) await Promise.all(writes);
}

async function doFetchDynamicModels(
  state: CatalogState,
  environment: Record<string, string | undefined>,
  options: ModelDiscoveryOptions,
  generation: number,
): Promise<DynamicModelEntry[] | null> {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  if (typeof timeout.unref === "function") timeout.unref();
  const remaining = () => Math.max(1, deadline - Date.now());
  const canCommit = () => state.requestGeneration === generation && !abortController.signal.aborted;
  try {
    // The Worker is the normal path and avoids any PATH dependency. If a
    // separately installed qodercli is present, try it in parallel as an
    // automatic compatibility fallback; neither path requires users to run a
    // model-list command themselves.
    const runtimes: Array<string | undefined> = [undefined];
    const cli = findQoderCLI();
    if (cli) runtimes.push(cli);
    const attempts = runtimes.map((runtimePath) => fetchFromRuntime(
      runtimePath,
      environment,
      options,
      deadline,
      abortController.signal,
    ));
    let emptySnapshot = false;
    let failures = 0;
    const pending = attempts.map((promise, index) => ({
      index,
      promise: promise.then((models) => ({ index, models })),
    }));
    while (pending.length > 0) {
      const result = await Promise.race(pending.map((item) => item.promise));
      const pendingIndex = pending.findIndex((item) => item.index === result.index);
      if (pendingIndex >= 0) pending.splice(pendingIndex, 1);
      if (Array.isArray(result.models)) {
        if (result.models.length > 0) {
          if (!canCommit()) return cloneModels(state.models);
          const committed = commitDiscoveredModels(state, result.models, generation);
          abortController.abort();
          return committed;
        }
        emptySnapshot = true;
      } else {
        failures += 1;
      }
    }
    if (!canCommit()) return cloneModels(state.models);
    if (emptySnapshot) {
      state.lastSuccessAt = 0;
      state.lastFailureAt = Date.now();
      debug("Live model catalog was empty; retaining the current catalog");
    }
    if (failures > 0) {
      state.lastFailureAt = Date.now();
      debug(`Live model catalog unavailable through ${failures} runtime attempt(s)`);
    }
    return cloneModels(state.models);
  } catch (error) {
    if (state.requestGeneration === generation) state.lastFailureAt = Date.now();
    debug("Live model catalog unavailable; keeping cached/fallback models:", describeError(error));
    return cloneModels(state.models);
  } finally {
    clearTimeout(timeout);
    abortController.abort();
  }
}

async function fetchFromRuntime(
  runtimePath: string | undefined,
  environment: Record<string, string | undefined>,
  options: ModelDiscoveryOptions,
  deadline: number,
  overallSignal: AbortSignal,
): Promise<ModelInfo[] | null> {
  if (overallSignal.aborted) return null;
  const abortController = new AbortController();
  const abortAttempt = () => abortController.abort();
  overallSignal.addEventListener("abort", abortAttempt, { once: true });
  let q: ReturnType<typeof query> | undefined;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    q = modelQueryFactory({
      prompt: idlePrompt(abortController.signal),
      options: {
        auth: qoderAuth(environment),
        model: "auto",
        abortController,
        persistSession: false,
        env: environment,
        ...(runtimePath ? { pathToQoderCLIExecutable: runtimePath } : {}),
        ...(safeOption(options.proxy) ? { proxy: safeOption(options.proxy) } : {}),
        ...(safeOption(options.vpcEndpoint) ? { vpcEndpoint: safeOption(options.vpcEndpoint) } : {}),
        ...(safeOption(options.cwd) ? { cwd: safeOption(options.cwd) } : {}),
        controlRequestTimeoutMs: Math.max(100, Math.min(5_000, remaining() - 100)),
        closeGraceMs: Math.min(CLEANUP_GRACE_MS, 500),
      },
    });
    await withTimeout(
      q.initializationResult(),
      remaining(),
      `Qoder model discovery initialization exceeded ${Math.max(1, deadline - Date.now())}ms`,
    );
    const models = await withTimeout(
      q.getAvailableModels({ fetchStrategy: "live" }),
      remaining(),
      `Qoder model discovery exceeded ${Math.max(1, deadline - Date.now())}ms`,
    );
    return Array.isArray(models) ? models : null;
  } catch (error) {
    debug(`Model discovery runtime${runtimePath ? " (qodercli fallback)" : " (bundled Worker)"} failed:`, describeError(error));
    return null;
  } finally {
    overallSignal.removeEventListener("abort", abortAttempt);
    abortController.abort();
    if (q) void closeAsyncIterator(q, CLEANUP_GRACE_MS);
  }
}

function commitDiscoveredModels(
  state: CatalogState,
  models: ModelInfo[],
  generation: number,
): DynamicModelEntry[] | null {
  if (state.requestGeneration !== generation) return cloneModels(state.models);
  const enabled = selectEnabledModels(models);
  debug(
    `Model catalog: ${enabled.length} usable of ${models.length} reported`
    + (enabled.length === 0 ? "" : ` (${enabled.map((m) => m.value).join(", ")})`),
  );
  // An empty live response is ambiguous (transient auth/scene/server
  // failures are returned this way by some SDK/CLI versions). Keep the last
  // known-good catalog and let the built-ins cover a genuinely empty cache.
  if (enabled.length === 0) return cloneModels(state.models);
  const mapped = enabled.map(mapModelInfo);
  state.models = mapped;
  state.liveUpdated = true;
  state.lastSuccessAt = Date.now();
  state.lastFailureAt = 0;
  if (activeCatalogScope === state.scope) rebuildIndex(mapped);
  // Cache persistence is deliberately detached from startup registration;
  // a slow filesystem must not hold OpenCode past the discovery deadline.
  void queueModelCacheWriteForState(state, mapped);
  return cloneModels(mapped);
}

function normalizeTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return FETCH_TIMEOUT_MS;
  return Math.min(FETCH_TIMEOUT_MS, Math.max(250, Math.floor(value)));
}
