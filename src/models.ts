import { query, type ModelInfo } from "@qoder-ai/qoder-agent-sdk";
import type { QoderModelDef } from "./types.js";
import { findQoderCLI } from "./auth.js";
import { idlePrompt } from "./sdk-session.js";
import { hasQoderCredential, qoderAuth } from "./sdk-auth.js";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
const FETCH_TIMEOUT_MS = 30_000;
const CLEANUP_GRACE_MS = 5_000;
const UNSAFE_IDS = new Set(["__proto__", "prototype", "constructor"]);

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
const MODEL_CACHE_FILE = join(STATE_DIR, "models.json");

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

export function getModel(id: string): QoderModelDef | undefined {
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

/**
 * Keep catalog entries that are usable model ids. Disabled entries are
 * dropped; anything else (BYOK, tagged, scene-filtered) stays so the bridge
 * never hides a model the server actually serves.
 */
export function selectEnabledModels(models: unknown): ModelInfo[] {
  if (!Array.isArray(models)) return [];
  return models.filter((m): m is ModelInfo => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return false;
    const value = (m as { value?: unknown }).value;
    return typeof value === "string"
      && value.trim().length > 0
      && value.length <= 256
      && !UNSAFE_IDS.has(value)
      && (m as { isEnabled?: unknown }).isEnabled !== false;
  });
}

function mapModelInfo(m: ModelInfo): DynamicModelEntry {
  const factor = finiteNonNegative(m.priceFactor, 1.0);
  const context = finitePositiveInteger(m.maxInputTokens, CONTEXT);
  const output = finitePositiveInteger(m.maxOutputTokens, OUTPUT);
  const vl = m.isVl === undefined ? true : m.isVl === true;
  return {
    id: m.value,
    name: typeof m.displayName === "string" && m.displayName.trim() ? m.displayName.trim().slice(0, 1024) : m.value,
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
  if (typeof model.id !== "string" || model.id.length === 0 || model.id.length > 256 || UNSAFE_IDS.has(model.id)) return false;
  if (typeof model.name !== "string" || model.name.length === 0 || model.name.length > 1024) return false;
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
    (items) => Array.isArray(items) && items.every((item) => typeof item === "string" && item.length <= 64),
  );
}

/**
 * Dynamically apply live model updates received from SDK streaming events
 * (`available_models_update`). Updates the in-memory index and cache file.
 */
export function applyLiveModelUpdates(models: unknown): DynamicModelEntry[] {
  const enabled = selectEnabledModels(models);
  const mapped = enabled.map(mapModelInfo);
  cachedDynamicModels = mapped;
  rebuildIndex(mapped);
  void queueModelCacheWrite(mapped);
  debug(`Live model update: refreshed ${mapped.length} models`);
  return getCachedDynamicModels() ?? [];
}

let cachedDynamicModels: DynamicModelEntry[] | null = loadCachedModels();

function loadCachedModels(): DynamicModelEntry[] | null {
  try {
    if (!existsSync(MODEL_CACHE_FILE)) return null;
    const info = lstatSync(MODEL_CACHE_FILE);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MODEL_CACHE_BYTES) return null;
    const parsed = JSON.parse(readFileSync(MODEL_CACHE_FILE, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return null;
    const models = parsed.filter(validCachedModel);
    rebuildIndex(models);
    return models;
  } catch (error) {
    debug("Model cache unreadable; using fallback catalog:", describeError(error));
    return null;
  }
}

export function listModels(): QoderModelDef[] {
  return [...MODEL_INDEX.values()].map((m) => ({ ...m, cost: { ...m.cost }, limit: { ...m.limit } }));
}

export function getCachedDynamicModels(): DynamicModelEntry[] | null {
  return cachedDynamicModels?.map((model) => ({
    ...model,
    limit: { ...model.limit },
    cost: { ...model.cost },
    modalities: { input: [...model.modalities.input], output: [...model.modalities.output] },
  })) ?? null;
}

let inflightFetch: Promise<DynamicModelEntry[] | null> | null = null;

export async function fetchDynamicModels(force = false): Promise<DynamicModelEntry[] | null> {
  if (cachedDynamicModels && !force) return getCachedDynamicModels();
  if (inflightFetch) return inflightFetch;
  inflightFetch = doFetchDynamicModels().finally(() => {
    inflightFetch = null;
  });
  return inflightFetch;
}

async function writeCacheFile(models: DynamicModelEntry[]): Promise<void> {
  let temporary: string | undefined;
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    try { chmodSync(STATE_DIR, 0o700); } catch { /* best-effort */ }
    temporary = join(STATE_DIR, `.models.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(models, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, MODEL_CACHE_FILE);
    temporary = undefined;
  } finally {
    if (temporary) {
      try { unlinkSync(temporary); } catch { /* best-effort */ }
    }
  }
}

let pendingModelsToWrite: DynamicModelEntry[] | null = null;
let activeWritePromise: Promise<void> | null = null;

async function processCacheWrite(): Promise<void> {
  while (pendingModelsToWrite !== null) {
    const toWrite = pendingModelsToWrite;
    pendingModelsToWrite = null;
    try {
      await writeCacheFile(toWrite);
    } catch (error) {
      debug("Model cache write failed:", describeError(error));
    }
  }
  activeWritePromise = null;
}

export function queueModelCacheWrite(models: DynamicModelEntry[]): Promise<void> {
  pendingModelsToWrite = models;
  activeWritePromise ??= processCacheWrite();
  return activeWritePromise;
}

export async function flushModelCache(): Promise<void> {
  if (activeWritePromise) await activeWritePromise;
}

async function doFetchDynamicModels(): Promise<DynamicModelEntry[] | null> {
  const cli = findQoderCLI();
  if (!hasQoderCredential()) return null;

  let q: ReturnType<typeof query> | undefined;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
  if (typeof timeout.unref === "function") timeout.unref();
  const sceneEnv = process.env.QODER_SCENE
    ? { env: { ...process.env, QODER_SCENE: process.env.QODER_SCENE } }
    : {};
  try {
    q = query({
      prompt: idlePrompt(abortController.signal),
      options: {
        auth: qoderAuth(),
        model: "auto",
        abortController,
        persistSession: false,
        ...(cli ? { pathToQoderCLIExecutable: cli } : {}),
        ...sceneEnv,
      },
    });
    // "live" forces a server refresh inside the CLI and falls back to the
    // CLI's cached catalog when the server returns nothing. The previous
    // "cache" strategy could serve an empty or stale subset, which hid
    // models until a lucky refresh.
    const models = await withTimeout(
      q.getAvailableModels({ fetchStrategy: "live" }),
      FETCH_TIMEOUT_MS,
      `Qoder model discovery exceeded ${FETCH_TIMEOUT_MS}ms`,
    );
    if (!Array.isArray(models)) return null;
    const enabled = selectEnabledModels(models);
    debug(
      `Model catalog: ${enabled.length} usable of ${models.length} reported`
      + (enabled.length === 0 ? "" : ` (${enabled.map((m) => m.value).join(", ")})`),
    );
    cachedDynamicModels = enabled.map(mapModelInfo);
    rebuildIndex(cachedDynamicModels);
    await queueModelCacheWrite(cachedDynamicModels);
    return getCachedDynamicModels();
  } catch (error) {
    debug("Live model catalog unavailable; keeping cached/fallback models:", describeError(error));
    return null;
  } finally {
    clearTimeout(timeout);
    abortController.abort();
    if (q) await closeAsyncIterator(q, CLEANUP_GRACE_MS);
  }
}
