import { query, type ModelInfo } from "@qoder-ai/qoder-agent-sdk";
import type { QoderModelDef } from "./types.js";
import { findQoderCLI } from "./auth.js";
import { idlePrompt } from "./sdk-session.js";
import { hasQoderPAT, qoderAuth } from "./sdk-auth.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveStateDir } from "./state-dir.js";
import { debug, describeError } from "./logger.js";

const CONTEXT = 200_000;
const OUTPUT = 32_000;

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

function addToIndex(m: DynamicModelEntry): void {
  MODEL_INDEX.set(m.id, {
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
  });
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
export function selectEnabledModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter(
    (m) => !!m && typeof m.value === "string" && m.value.length > 0 && m.isEnabled !== false,
  );
}

function mapModelInfo(m: ModelInfo): DynamicModelEntry {
  const factor = m.priceFactor ?? 1.0;
  const context = m.maxInputTokens ?? CONTEXT;
  const output = m.maxOutputTokens ?? OUTPUT;
  const vl = m.isVl ?? true;
  return {
    id: m.value,
    name: m.displayName,
    attachment: vl,
    reasoning: m.isReasoning ?? false,
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

let cachedDynamicModels: DynamicModelEntry[] | null = loadCachedModels();

function loadCachedModels(): DynamicModelEntry[] | null {
  try {
    if (!existsSync(MODEL_CACHE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(MODEL_CACHE_FILE, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return null;
    const models = parsed.filter((m): m is DynamicModelEntry => {
      if (!m || typeof m !== "object") return false;
      const x = m as Record<string, unknown>;
      return typeof x.id === "string" && typeof x.name === "string" && typeof x.attachment === "boolean"
        && typeof x.reasoning === "boolean" && typeof x.toolCall === "boolean" && typeof x.limit === "object"
        && typeof x.cost === "object" && typeof x.modalities === "object";
    });
    for (const model of models) addToIndex(model);
    return models.length > 0 ? models : null;
  } catch (error) {
    debug("Model cache unreadable; using fallback catalog:", describeError(error));
    return null;
  }
}

export function listModels(): QoderModelDef[] {
  return [...MODEL_INDEX.values()].map((m) => ({ ...m, cost: { ...m.cost }, limit: { ...m.limit } }));
}

export function getCachedDynamicModels(): DynamicModelEntry[] | null {
  return cachedDynamicModels;
}

let inflightFetch: Promise<DynamicModelEntry[] | null> | null = null;

export async function fetchDynamicModels(force = false): Promise<DynamicModelEntry[] | null> {
  if (cachedDynamicModels && !force) return cachedDynamicModels;
  if (inflightFetch) return inflightFetch;
  inflightFetch = doFetchDynamicModels().finally(() => {
    inflightFetch = null;
  });
  return inflightFetch;
}

async function writeCacheFile(models: DynamicModelEntry[]): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(STATE_DIR, 0o700); } catch { /* best-effort */ }
  const temporary = join(STATE_DIR, `.models.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(models, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, MODEL_CACHE_FILE);
}

async function doFetchDynamicModels(): Promise<DynamicModelEntry[] | null> {
  const cli = findQoderCLI();
  if (!cli && !hasQoderPAT()) return null;

  let q: ReturnType<typeof query> | undefined;
  const abortController = new AbortController();
  const sceneEnv = process.env.QODER_SCENE
    ? { env: { QODER_SCENE: process.env.QODER_SCENE } }
    : {};
  try {
    q = query({
      prompt: idlePrompt(abortController.signal),
      options: {
        auth: qoderAuth(),
        model: "auto",
        abortController,
        ...(cli ? { pathToQoderCLIExecutable: cli } : {}),
        ...sceneEnv,
      },
    });
    // "live" forces a server refresh inside the CLI and falls back to the
    // CLI's cached catalog when the server returns nothing. The previous
    // "cache" strategy could serve an empty or stale subset, which hid
    // models until a lucky refresh.
    const models = await q.getAvailableModels({ fetchStrategy: "live" });
    if (!Array.isArray(models)) return null;
    const enabled = selectEnabledModels(models);
    debug(
      `Model catalog: ${enabled.length} usable of ${models.length} reported`
      + (enabled.length === 0 ? "" : ` (${enabled.map((m) => m.value).join(", ")})`),
    );
    if (enabled.length === 0) return null;
    cachedDynamicModels = enabled.map(mapModelInfo);
    for (const m of cachedDynamicModels) addToIndex(m);
    await writeCacheFile(cachedDynamicModels).catch((error) => {
      debug("Model cache write failed:", describeError(error));
    });
    return cachedDynamicModels;
  } catch (error) {
    debug("Live model catalog unavailable; keeping cached/fallback models:", describeError(error));
    return null;
  } finally {
    abortController.abort();
    try { await q?.return(undefined); } catch { /* ignore */ }
  }
}
