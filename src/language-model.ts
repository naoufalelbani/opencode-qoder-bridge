import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { query } from "@qoder-ai/qoder-agent-sdk";
import type { Options, Query, SDKArtifactInfo, SDKPlanModeSnapshot } from "@qoder-ai/qoder-agent-sdk";
import { getModel, DEFAULT_MODEL_ID, applyLiveModelUpdates } from "./models.js";
import { findQoderCLI } from "./auth.js";
import { buildPromptString, buildPromptIterable, latestPrompt, promptHasImage } from "./prompt-builder.js";
import { normalizeToolName, normalizeToolInputString } from "./tool-normalizer.js";
import { recordTurn } from "./cost.js";
import type { QoderBridgeOptions } from "./types.js";
import { deleteQoderSession, ensureQoderSession, getQoderSessionForCwd, getQoderSessionResetEpoch, withQoderSessionLease } from "./session-store.js";
import { hasQoderCredential, qoderAuth } from "./sdk-auth.js";
import { QoderAuthError, QoderSdkResultError } from "./errors.js";
import { debug, describeError, redactSensitiveText } from "./logger.js";

type StreamController = ReadableStreamDefaultController<LanguageModelV3StreamPart>;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const UNSAFE_METADATA_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const CLEANUP_GRACE_MS = 5_000;
const MAX_SEEN_MESSAGE_IDS = 100_000;
const MAX_TOOL_INPUT_CHARS = 4_000_000;
const MAX_OUTPUT_CHARS = 8_000_000;
const MAX_METADATA_NODES = 2_000;
const MAX_METADATA_STRING = 4_096;
const MAX_STOP_REASON_LENGTH = 256;
const QODER_BUILTIN_NAMES: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  delete: "Delete",
  view: "View",
  bash: "Bash",
  glob: "Glob",
  grep: "Grep",
  task: "Agent",
  task_create: "TaskCreate",
  taskcreate: "TaskCreate",
  task_get: "TaskGet",
  taskget: "TaskGet",
  task_update: "TaskUpdate",
  taskupdate: "TaskUpdate",
  task_list: "TaskList",
  tasklist: "TaskList",
  question: "AskUserQuestion",
  ask_user_question: "AskUserQuestion",
  plan_exit: "ExitPlanMode",
  exit_plan_mode: "ExitPlanMode",
  skill: "Skill",
  todo_write: "TodoWrite",
  todowrite: "TodoWrite",
  update_goal: "UpdateGoal",
  updategoal: "UpdateGoal",
  web_fetch: "WebFetch",
  webfetch: "WebFetch",
  web_search: "WebSearch",
  websearch: "WebSearch",
  image_gen: "ImageGen",
  imagegen: "ImageGen",
  image_search: "ImageSearch",
  imagesearch: "ImageSearch",
  notebook_edit: "NotebookEdit",
  notebookedit: "NotebookEdit",
};

function toJsonValue(value: unknown, depth = 0, budget: { remaining: number } = { remaining: MAX_METADATA_NODES }): JsonValue | undefined {
  if (depth > 8) return undefined;
  if (budget.remaining-- <= 0) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, MAX_METADATA_STRING);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const item of value) {
      const normalized = toJsonValue(item, depth + 1, budget);
      if (normalized !== undefined) out.push(normalized);
      if (budget.remaining <= 0) break;
    }
    return out;
  }
  if (!isRecord(value)) return undefined;
  const out: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_METADATA_KEYS.has(key)) continue;
    const normalized = toJsonValue(item, depth + 1, budget);
    if (normalized !== undefined) {
      Object.defineProperty(out, key.slice(0, 256), {
        configurable: true,
        enumerable: true,
        value: normalized,
        writable: true,
      });
    }
    if (budget.remaining <= 0) break;
  }
  return out;
}

function safeEnqueue(controller: StreamController, part: LanguageModelV3StreamPart): boolean {
  try {
    controller.enqueue(part);
    return true;
  } catch {
    return false;
  }
}

function safeClose(controller: StreamController): void {
  try {
    controller.close();
  } catch {
    // Controller already closed or cancelled
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function makeFinishReason(
  unified: LanguageModelV3FinishReason["unified"],
  raw?: string,
): LanguageModelV3FinishReason {
  return {
    unified,
    raw: raw === undefined ? undefined : redactSensitiveText(raw).slice(0, MAX_STOP_REASON_LENGTH),
  };
}

function safeStopReason(value: unknown): string | null {
  return typeof value === "string"
    ? redactSensitiveText(value).slice(0, MAX_STOP_REASON_LENGTH)
    : null;
}

function makeUsage(input: number, output: number, cacheRead: number, cacheWrite: number): LanguageModelV3Usage {
  const safeInput = finiteNonNegative(input);
  const safeOutput = finiteNonNegative(output);
  const safeCacheRead = Math.min(safeInput, finiteNonNegative(cacheRead));
  const safeCacheWrite = Math.min(safeInput - safeCacheRead, finiteNonNegative(cacheWrite));
  return {
    inputTokens: {
      total: safeInput,
      noCache: Math.max(0, safeInput - safeCacheRead - safeCacheWrite),
      cacheRead: safeCacheRead,
      cacheWrite: safeCacheWrite,
    },
    outputTokens: {
      total: safeOutput,
      text: safeOutput,
      reasoning: undefined,
    },
  };
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function requestTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

function abortError(): Error {
  const error = new Error("Qoder request aborted");
  error.name = "AbortError";
  return error;
}

function safePublicError(error: unknown): Error {
  if (error instanceof QoderAuthError || error instanceof QoderSdkResultError) return error;
  return new Error(describeError(error) || "Qoder request failed");
}

function tokenCount(value: unknown): number {
  return Math.floor(finiteNonNegative(value));
}

function ratio(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(1, value)
    : undefined;
}

function safeJsonStringify(value: unknown): string | undefined {
  try { return JSON.stringify(value); } catch { return undefined; }
}

function messageDedupeKey(message: Record<string, unknown>): string | undefined {
  const uuid = typeof message.uuid === "string" && message.uuid.trim() ? message.uuid : undefined;
  if (!uuid) return undefined;
  // Some SDK versions reuse an outer UUID for several stream frames, while
  // replayed frames repeat the complete payload. Hashing the payload keeps
  // the latter idempotent without dropping legitimate same-UUID frames.
  const payload = safeJsonStringify(message) ?? `${message.type ?? ""}:${message.event ?? ""}`;
  return `${uuid}\u0000${createHash("sha256").update(payload).digest("hex")}`;
}

function rememberId(seen: Set<string>, id: string, maxSize: number): boolean {
  if (seen.has(id)) return false;
  if (seen.size >= maxSize) {
    const oldest = seen.values().next().value;
    if (typeof oldest === "string") seen.delete(oldest);
  }
  seen.add(id);
  return true;
}

function isAuthenticationError(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /auth|credential|token|unauthori|forbidden/i.test(value);
}

function resolveCwd(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return process.cwd();
  try {
    const resolved = resolve(value);
    try { return realpathSync(resolved); } catch { return resolved; }
  } catch { return process.cwd(); }
}

function qoderEnvironment(environment: Record<string, string | undefined> | undefined): Record<string, string | undefined> {
  return environment ? { ...process.env, ...environment } : process.env;
}

const sessionTails = new Map<string, Promise<void>>();

function waitForTurn(previous: Promise<void>, signal: AbortSignal | undefined): Promise<boolean> {
  if (!signal) return previous.then(() => true, () => true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolveResult(ready);
    };
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(() => finish(true), () => finish(true));
    if (signal.aborted) finish(false);
  });
}

async function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T> | undefined> {
  if (signal.aborted) return undefined;
  let onAbort!: () => void;
  const aborted = new Promise<undefined>((resolveAbort) => {
    onAbort = () => resolveAbort(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function withSessionLock<T>(
  key: string | undefined,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  if (!key) {
    if (signal?.aborted) return undefined;
    return fn();
  }

  const previous = sessionTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
  sessionTails.set(key, current);

  const acquired = await waitForTurn(previous, signal);
  const releaseAndClean = () => {
    release();
    if (sessionTails.get(key) === current) sessionTails.delete(key);
  };
  if (!acquired) {
    // Keep the queue closed behind the still-running request, even when this
    // waiter is canceled before it reaches the SDK.
    void previous.then(releaseAndClean, releaseAndClean);
    return undefined;
  }

  try {
    if (signal?.aborted) return undefined;
    return await fn();
  } finally {
    releaseAndClean();
  }
}

function mapStopReason(stopReason: string | null | undefined, hasToolCalls: boolean): LanguageModelV3FinishReason {
  if (hasToolCalls) return makeFinishReason("tool-calls", stopReason ?? undefined);
  switch (stopReason) {
    case "max_tokens":
      return makeFinishReason("length", stopReason);
    case "refusal":
      return makeFinishReason("content-filter", stopReason);
    default:
      return makeFinishReason("stop", stopReason ?? undefined);
  }
}

type OpenBlock =
  | { kind: "reasoning" | "text"; index: number }
  | { kind: "tool"; index: number; id: string; providerExecuted: boolean };

interface StreamState {
  controller: StreamController;
  contextWindow: number;
  functionToolNames: Set<string>;
  activeText: Set<number>;
  activeReasoning: Set<number>;
  toolBlocks: Map<number, { id: string; name: string; input: string; providerExecuted: boolean; hasInput: boolean }>;
  openBlocks: OpenBlock[];
  sawStreamText: boolean;
  sawStreamTool: boolean;
  sawStreamReasoning: boolean;
  emittedToolCall: boolean;
  pendingToolCalls: Map<string, { name: string; providerExecuted: boolean }>;
  lastStopReason: string | null;
  blockCounter: number;
  outputChars: number;
  finished: boolean;
  resultReceived: boolean;
  seenToolCallIds?: Set<string>;
  seenMessageIds?: Set<string>;
  failed?: boolean;
  authExpired?: boolean;
  invalidSession?: boolean;
  artifacts: SDKArtifactInfo[];
  planMode?: SDKPlanModeSnapshot;
  skillEvolution?: Record<string, unknown>;
}

function trackOpenBlock(state: StreamState, block: OpenBlock): void {
  if (!state.openBlocks.some((item) => item.index === block.index)) state.openBlocks.push(block);
}

function untrackOpenBlock(state: StreamState, index: number): void {
  const position = state.openBlocks.findIndex((item) => item.index === index);
  if (position >= 0) state.openBlocks.splice(position, 1);
}

export function isProviderExecutedTool(name: string, functionToolNames: ReadonlySet<string>): boolean {
  return !functionToolNames.has(name);
}

function isProviderOwnedTool(rawName: string, normalizedName: string, functionToolNames: ReadonlySet<string>): boolean {
  // Bridged MCP servers are executed by Qoder. Do not normalize an MCP name
  // into an unrelated OpenCode function and execute the same call twice.
  if (rawName.trim().toLowerCase().startsWith("mcp__")) return true;
  return isProviderExecutedTool(normalizedName, functionToolNames);
}

function qoderToolNameForHost(rawName: string): string {
  const trimmed = rawName.trim();
  const normalized = normalizeToolName(trimmed);
  return QODER_BUILTIN_NAMES[normalized] ?? trimmed;
}

function isProviderOwnedToolName(name: string): boolean {
  return name.trim().toLowerCase().startsWith("mcp__");
}

export class QoderLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "qoder" as const;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly bridgeOptions: QoderBridgeOptions;

  constructor(modelId: string, bridgeOptions: QoderBridgeOptions = {}) {
    this.modelId = modelId;
    this.bridgeOptions = bridgeOptions;
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    if (options.abortSignal?.aborted) throw abortError();
    const { stream } = await this.doStream(options);
    const reader = stream.getReader();

    let text = "";
    let reasoning = "";
    let finishReason: LanguageModelV3FinishReason = makeFinishReason("stop");
    let usage: LanguageModelV3Usage = makeUsage(0, 0, 0, 0);
    let providerMetadata: LanguageModelV3GenerateResult["providerMetadata"];
    let sawFinish = false;
    const toolCalls: Array<Extract<LanguageModelV3Content, { type: "tool-call" }>> = [];

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        switch (value.type) {
          case "text-delta":
            text += value.delta;
            break;
          case "reasoning-delta":
            reasoning += value.delta;
            break;
          case "tool-call":
            toolCalls.push({
              type: "tool-call",
              toolCallId: value.toolCallId,
              toolName: value.toolName,
              input: value.input,
            });
            break;
          case "finish":
            sawFinish = true;
            finishReason = value.finishReason;
            usage = value.usage;
            providerMetadata = value.providerMetadata;
            break;
          case "error":
            throw safePublicError(value.error);
        }
      }
    } catch (error) {
      try { await reader.cancel(); } catch { /* best-effort stream cleanup */ }
      throw error;
    } finally {
      try { reader.releaseLock(); } catch { /* reader may already be released */ }
    }

    if (!sawFinish) {
      if (options.abortSignal?.aborted) throw abortError();
      throw new QoderSdkResultError("incomplete_stream", "Qoder stream closed before sending a finish message");
    }

    const content: Array<LanguageModelV3Content> = [];
    if (reasoning) content.push({ type: "reasoning", text: reasoning });
    if (text) content.push({ type: "text", text });
    content.push(...toolCalls);

    return { content, finishReason, usage, providerMetadata, warnings: [] };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const cli = findQoderCLI();
    const childEnvironment = qoderEnvironment(this.bridgeOptions.env);
    if (!hasQoderCredential(childEnvironment)) {
      throw new QoderAuthError(
        "No Qoder credentials found. Run `qoder login` or set QODER_PERSONAL_ACCESS_TOKEN.",
      );
    }

    const resolved = getModel(this.modelId);
    const model = resolved ?? getModel(DEFAULT_MODEL_ID)!;
    if (!resolved) {
      // Use the default catalog entry only for conservative prompt limits.
      // Preserve the requested ID on the SDK call so an unknown model is not
      // silently replaced by a different model.
      debug(`Unknown model id "${this.modelId}"; forwarding it with default prompt limits`);
    }
    const sessionKey = this.bridgeOptions.sessionKey ?? this.bridgeOptions.sessionId;
    const cwd = resolveCwd(this.bridgeOptions.cwd);

    const functionToolNames = new Set(
      (options.tools ?? [])
        .filter((t) => t.type === "function")
        .map((t) => normalizeToolName(t.name)),
    );
    const hostToolNames = (options.tools ?? [])
      .filter((tool) => tool.type === "function")
      // MCP tools configured through mcpServers are executed by Qoder. They
      // are provider-owned and must not be added to the native denylist.
      .filter((tool) => !isProviderOwnedToolName(tool.name))
      .map((tool) => qoderToolNameForHost(tool.name));

    const abortController = new AbortController();
    let qoderQuery: Query | null = null;
    let externallyAborted = false;
    let timedOut = false;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const timeoutMs = requestTimeoutMs(this.bridgeOptions.timeoutMs);
    const timeoutError = () => new QoderSdkResultError("timeout", `Qoder request exceeded ${timeoutMs}ms`);
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      if (requestTimer) clearTimeout(requestTimer);
      if (options.abortSignal) {
        try { options.abortSignal.removeEventListener("abort", markExternal); } catch { /* ignore */ }
      }
      try { abortController.abort(); } catch { /* best-effort cancellation */ }
      const activeQuery = qoderQuery;
      cleanupPromise = (async () => {
        if (!activeQuery) return;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            activeQuery.return(undefined).then(() => undefined, () => undefined),
            new Promise<void>((resolveCleanup) => {
              graceTimer = setTimeout(resolveCleanup, CLEANUP_GRACE_MS);
              if (typeof graceTimer.unref === "function") graceTimer.unref();
            }),
          ]);
        } catch {
          // A transport may reject/throw while it is being torn down.
        } finally {
          if (graceTimer) clearTimeout(graceTimer);
        }
      })();
      return cleanupPromise;
    };
    const markExternal = () => {
      externallyAborted = true;
      void cleanup();
    };

    if (options.abortSignal) {
      if (options.abortSignal.aborted) markExternal();
      else options.abortSignal.addEventListener("abort", markExternal, { once: true });
    }

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      cancel: markExternal,
      start: async (controller) => {
        const state: StreamState = {
          controller,
          contextWindow: model.limit.context,
          functionToolNames,
          activeText: new Set(),
          activeReasoning: new Set(),
          toolBlocks: new Map(),
          openBlocks: [],
          sawStreamText: false,
          sawStreamTool: false,
          sawStreamReasoning: false,
          emittedToolCall: false,
          pendingToolCalls: new Map(),
          lastStopReason: null,
          blockCounter: 0,
          outputChars: 0,
          finished: false,
          resultReceived: false,
          seenToolCallIds: new Set(),
          seenMessageIds: new Set(),
          artifacts: [],
          planMode: undefined,
          skillEvolution: undefined,
        };

        safeEnqueue(controller, { type: "stream-start", warnings: [] });

        try {
          if (externallyAborted) {
            safeClose(controller);
            return;
          }
          requestTimer = setTimeout(() => {
            timedOut = true;
            debug(`Qoder request timed out after ${timeoutMs}ms`);
            void cleanup();
          }, timeoutMs);
          if (typeof requestTimer.unref === "function") requestTimer.unref();

          const lockKey = sessionKey ? `${cwd}\u0000${sessionKey}` : undefined;
          const leaseKey = [this.bridgeOptions.sessionId, sessionKey]
            .find((value): value is string => typeof value === "string" && value.trim().length > 0);
          const runTurn = () => withSessionLock(lockKey, abortController.signal, async () => {
            let persisted: Awaited<ReturnType<typeof getQoderSessionForCwd>> = null;
            let resetEpoch: string | undefined;
            try {
              if (externallyAborted) return;

              if (this.bridgeOptions.sessionPersistence && sessionKey) {
                resetEpoch = await getQoderSessionResetEpoch();
                try {
                  persisted = await getQoderSessionForCwd(sessionKey, cwd);
                } catch (error) {
                  // Persistence contention or corruption must not make a fresh
                  // chat turn unavailable; the mapping can be repaired later.
                  debug("Could not read Qoder session mapping; starting fresh:", describeError(error));
                }
              }
              const sessionId = this.bridgeOptions.sessionId ?? persisted?.qoderSessionId ?? randomUUID();
              const shouldResume = Boolean(this.bridgeOptions.sessionId || persisted);
              debug(`doStream model=${model.id} sessionId=${sessionId} cwd=${cwd} resume=${shouldResume}`);

              const promptMessages = options.prompt as unknown as Array<{ role: string; content: unknown }>;
              const promptInput = shouldResume ? latestPrompt(promptMessages) : promptMessages;
              const prompt = promptHasImage(promptInput)
                ? buildPromptIterable(promptInput, model.limit.context, sessionId)
                : buildPromptString(promptInput, model.limit.context);
              const qoderOptions = this.buildQueryOptions(
                cli,
                sessionId,
                abortController,
                shouldResume,
                this.modelId,
                cwd,
                hostToolNames,
                () => {
                  state.authExpired = true;
                  try { abortController.abort(); } catch { /* best-effort cancellation */ }
                },
              );

              if (externallyAborted || abortController.signal.aborted) return;
              qoderQuery = query({ prompt, options: qoderOptions });
              const activeQuery = qoderQuery;
              if (externallyAborted || abortController.signal.aborted) return;
              const iterator = activeQuery[Symbol.asyncIterator]();
              for (;;) {
                const next = await nextWithAbort(iterator, abortController.signal);
                if (!next || next.done) break;
                if (externallyAborted || timedOut) break;
                handleSdkMessage(next.value as Record<string, unknown>, state);
                if (state.authExpired || state.finished) break;
              }

              if (state.authExpired && !state.finished) {
                throw new QoderAuthError("Qoder authentication expired during the request. Re-authenticate with `qoder login` or refresh QODER_PERSONAL_ACCESS_TOKEN.");
              }
              if (timedOut) throw timeoutError();
              if (!externallyAborted && !state.resultReceived && !state.finished) {
                throw new QoderSdkResultError("incomplete_stream", "Qoder ended the stream before sending a result message");
              }

              if (!externallyAborted && !state.failed && !abortController.signal.aborted && this.bridgeOptions.sessionPersistence && sessionKey) {
                try {
                  await ensureQoderSession(sessionKey, sessionId, cwd, resetEpoch);
                } catch (error) {
                  debug("Could not persist Qoder session mapping:", describeError(error));
                }
              }
              if (state.invalidSession && persisted && sessionKey) {
                try {
                  await deleteQoderSession(sessionKey, cwd);
                } catch (error) {
                  debug("Could not clear invalid Qoder session mapping:", describeError(error));
                }
              }
            } catch (error) {
              // A transport/query failure may arrive before Qoder can emit a
              // structured result. Clear a persisted session when its error
              // still identifies the resume target as invalid, so the next
              // request can recover with a fresh Qoder session.
              if (persisted && sessionKey && this.bridgeOptions.sessionPersistence && isLikelyInvalidSessionError(error)) {
                try {
                  await deleteQoderSession(sessionKey, cwd);
                } catch (deleteError) {
                  debug("Could not clear invalid Qoder session mapping after transport failure:", describeError(deleteError));
                }
              }
              throw error;
            } finally {
              await cleanup();
            }
          });
          if (leaseKey) {
            await withQoderSessionLease(leaseKey, cwd, abortController.signal, runTurn);
          } else {
            await runTurn();
          }

          if (!state.finished && !externallyAborted) {
            if (timedOut) throw timeoutError();
            if (!state.resultReceived) {
              throw new QoderSdkResultError("incomplete_stream", "Qoder ended the stream before sending a result message");
            }
            emitFinish(state, makeUsage(0, 0, 0, 0), makeFinishReason("stop"), undefined);
          }
          await cleanup();
          safeClose(controller);
        } catch (err) {
          await cleanup();
          if (externallyAborted) {
            debug("Stream aborted by caller; closing without finish");
            safeClose(controller);
            return;
          }
          debug("Stream failed:", describeError(err));
          if (!state.finished) {
            const streamError = state.authExpired
              ? new QoderAuthError("Qoder authentication expired during the request. Re-authenticate with `qoder login` or refresh QODER_PERSONAL_ACCESS_TOKEN.")
              : timedOut ? timeoutError()
              : safePublicError(err);
            closeOpenBlocks(state);
            safeEnqueue(controller, { type: "error", error: streamError });
            emitFinish(state, makeUsage(0, 0, 0, 0), makeFinishReason("error"), undefined);
          }
          safeClose(controller);
        }
      },
    });

    return { stream };
  }

  private buildQueryOptions(
    cli: string | null,
    sessionId: string,
    abortController: AbortController,
    shouldResume: boolean,
    modelId: string = this.modelId,
    cwd: string = resolveCwd(this.bridgeOptions.cwd),
    hostToolNames: readonly string[] = [],
    onAuthExpired?: () => void,
  ): Options {
    const sessionKey = this.bridgeOptions.sessionKey ?? this.bridgeOptions.sessionId;
    const permissionMode = this.bridgeOptions.permissionMode ?? "default";
    const opts: Options = {
      auth: qoderAuth(qoderEnvironment(this.bridgeOptions.env)),
      model: modelId,
      allowDangerouslySkipPermissions: this.bridgeOptions.allowDangerouslySkipPermissions
        ?? (permissionMode === "bypassPermissions" ? true : undefined),
      permissionMode,
      includePartialMessages: true,
      sessionId,
      cwd,
      abortController,
    };

    if (onAuthExpired) opts.onAuthExpired = onAuthExpired;

    if (cli) opts.pathToQoderCLIExecutable = cli;
    if (this.bridgeOptions.env) opts.env = qoderEnvironment(this.bridgeOptions.env);
    if (this.bridgeOptions.planMode !== undefined) opts.planMode = this.bridgeOptions.planMode;
    const proxy = this.bridgeOptions.proxy ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    if (proxy) opts.proxy = proxy;
    if (this.bridgeOptions.evolution) opts.evolution = this.bridgeOptions.evolution;

    const persistSession = Boolean(this.bridgeOptions.sessionId || (this.bridgeOptions.sessionPersistence && sessionKey));
    opts.persistSession = persistSession;
    if (persistSession && shouldResume) opts.resume = sessionId;
    if (this.bridgeOptions.allowedTools) opts.allowedTools = this.bridgeOptions.allowedTools;
    const disallowedTools = [
      ...(this.bridgeOptions.disallowedTools ?? []),
      ...hostToolNames
        .filter((name) => !isProviderOwnedToolName(name))
        .map(qoderToolNameForHost),
    ]
      .filter((name, index, all) => typeof name === "string" && name.trim() && all.indexOf(name) === index);
    if (disallowedTools.length > 0) opts.disallowedTools = disallowedTools;

    const mcpServers = this.bridgeOptions.mcpServers;
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      opts.mcpServers = mcpServers as Options["mcpServers"];
    }
    if (this.bridgeOptions.extraArgs && Object.keys(this.bridgeOptions.extraArgs).length > 0) {
      opts.extraArgs = Object.fromEntries(
        Object.entries(this.bridgeOptions.extraArgs).map(([key, value]) => [key.replace(/^--/, ""), value]),
      );
    }
    return opts;
  }
}

export function handleSdkMessage(m: Record<string, unknown>, state: StreamState): void {
  if (state.finished || !isRecord(m)) return;
  const messageId = messageDedupeKey(m);
  if (messageId) {
    const seenMessageIds = state.seenMessageIds ??= new Set();
    if (!rememberId(seenMessageIds, messageId, MAX_SEEN_MESSAGE_IDS)) return;
  }
  const type = typeof m.type === "string" ? m.type : "";
  if (!type.trim()) {
    failStream(state, "malformed_stream", "Qoder sent a message without a type");
    return;
  }
  if (type === "stream_event") {
    if (!isRecord(m.event)) {
      failStream(state, "malformed_stream", "Qoder sent a stream message without an event");
      return;
    }
    handleStreamEvent(m.event, state);
  } else if (type === "assistant") {
    handleAssistant(m, state);
  } else if (type === "result") {
    handleResult(m, state);
  } else if (type === "system") {
    handleSystem(m, state);
  }
}

function handleSystem(m: Record<string, unknown>, state: StreamState): void {
  const subtype = typeof m.subtype === "string" ? m.subtype : "";
  if (subtype === "plan_mode_changed" && isRecord(m.plan_mode)) {
    if (typeof m.plan_mode.active !== "boolean") return;
    state.planMode = m.plan_mode as unknown as SDKPlanModeSnapshot;
    debug(`Plan mode changed: active=${state.planMode.active}`);
  } else if (subtype === "available_models_update" && Array.isArray(m.models)) {
    debug(`Received live available_models_update with ${m.models.length} models`);
    applyLiveModelUpdates(m.models);
  } else if (subtype === "artifacts_update" && Array.isArray(m.artifacts)) {
    const incoming = m.artifacts.slice(0, 1_000);
    for (const artifact of incoming) {
      if (!isRecord(artifact)) continue;
      const safeArtifact = toJsonValue(artifact);
      if (!isRecord(safeArtifact)) continue;
      const path = typeof safeArtifact.path === "string" ? safeArtifact.path : "";
      const index = path ? state.artifacts.findIndex((item) => item.path === path) : -1;
      if (index >= 0) state.artifacts[index] = safeArtifact as unknown as SDKArtifactInfo;
      else if (state.artifacts.length < 1000) state.artifacts.push(safeArtifact as unknown as SDKArtifactInfo);
    }
    debug(`Artifacts updated: ${incoming.length} artifact(s)`);
  } else if (subtype === "skill_evolution" && isRecord(m.result)) {
    state.skillEvolution = m.result;
    debug(`Skill evolution result: status=${(m.result as Record<string, unknown>).status}`);
  }
}

function handleStreamEvent(ev: Record<string, unknown> | undefined, state: StreamState): void {
  if (!isRecord(ev)) {
    failStream(state, "malformed_stream", "Qoder sent a stream event that was not an object");
    return;
  }
  const { controller } = state;
  const evType = typeof ev.type === "string" ? ev.type : "";
  if (!evType.trim()) {
    failStream(state, "malformed_stream", "Qoder sent a stream event without a type");
    return;
  }
  const isContentBlockEvent = evType === "content_block_start"
    || evType === "content_block_delta"
    || evType === "content_block_stop";
  const idx = typeof ev.index === "number" && Number.isInteger(ev.index) && ev.index >= 0 && ev.index < 100_000
    ? ev.index
    : -1;
  if (isContentBlockEvent && idx < 0) {
    failStream(state, "malformed_stream", "Qoder sent a content block event without a valid index");
    return;
  }

  if (evType === "content_block_start" && !isRecord(ev.content_block)) {
    failStream(state, "malformed_stream", "Qoder sent a content block start without a block");
    return;
  }

  if (evType === "content_block_start" && isRecord(ev.content_block)) {
    if (state.toolBlocks.has(idx)) {
      const existing = state.toolBlocks.get(idx);
      if (existing && ev.content_block.id === existing.id) return;
      failStream(state, "malformed_stream", "Qoder started a different tool block at an open index");
      return;
    }
    if (state.activeReasoning.has(idx) || state.activeText.has(idx)) {
      failStream(state, "malformed_stream", "Qoder started a content block that was already open");
      return;
    }
    const block = ev.content_block;
    const blockType = typeof block.type === "string" ? block.type : "";
    if (blockType === "tool_use" && typeof block.id === "string" && block.id.trim() && typeof block.name === "string" && block.name.trim()) {
      const seenToolCallIds = state.seenToolCallIds ??= new Set();
      if (!rememberId(seenToolCallIds, block.id, MAX_SEEN_MESSAGE_IDS) || state.toolBlocks.has(idx)) return;
      state.sawStreamTool = true;
      const name = normalizeToolName(block.name);
      const providerExecuted = isProviderOwnedTool(block.name, name, state.functionToolNames);
      const hasInput = Object.hasOwn(block, "input");
      const initialInput = hasInput ? safeJsonStringify(block.input) : "";
      if (hasInput && (initialInput === undefined || initialInput.length > MAX_TOOL_INPUT_CHARS)) {
        failStream(state, "malformed_tool_input", `Qoder sent unserializable input for tool ${name}`);
        return;
      }
      state.toolBlocks.set(idx, { id: block.id, name, input: initialInput ?? "", providerExecuted, hasInput });
      trackOpenBlock(state, { kind: "tool", index: idx, id: block.id, providerExecuted });
      if (!providerExecuted) {
        safeEnqueue(controller, { type: "tool-input-start", id: block.id, toolName: name });
      }
    } else if (blockType === "tool_use") {
      failStream(state, "malformed_tool_call", "Qoder sent a tool call without a valid id or name");
    } else if (blockType === "thinking") {
      state.activeReasoning.add(idx);
      trackOpenBlock(state, { kind: "reasoning", index: idx });
      safeEnqueue(controller, { type: "reasoning-start", id: String(idx) });
    } else if (blockType === "text") {
      state.activeText.add(idx);
      trackOpenBlock(state, { kind: "text", index: idx });
      safeEnqueue(controller, { type: "text-start", id: String(idx) });
    } else {
      failStream(state, "malformed_stream", `Qoder sent an unsupported content block type: ${blockType || "missing"}`);
    }
    return;
  }

  if (evType === "content_block_delta" && isRecord(ev.delta)) {
    const delta = ev.delta;
    const deltaType = delta.type as string;
    if (deltaType === "thinking_delta" && typeof delta.thinking === "string") {
      state.sawStreamReasoning = true;
      if (!state.activeReasoning.has(idx)) {
        state.activeReasoning.add(idx);
        trackOpenBlock(state, { kind: "reasoning", index: idx });
        safeEnqueue(controller, { type: "reasoning-start", id: String(idx) });
      }
      if (delta.thinking && appendOutput(state, delta.thinking)) {
        safeEnqueue(controller, { type: "reasoning-delta", id: String(idx), delta: delta.thinking });
      }
    } else if (deltaType === "text_delta" && typeof delta.text === "string") {
      state.sawStreamText = true;
      if (!state.activeText.has(idx)) {
        state.activeText.add(idx);
        trackOpenBlock(state, { kind: "text", index: idx });
        safeEnqueue(controller, { type: "text-start", id: String(idx) });
      }
      if (delta.text && appendOutput(state, delta.text)) {
        safeEnqueue(controller, { type: "text-delta", id: String(idx), delta: delta.text });
      }
    } else if (deltaType === "input_json_delta" && typeof delta.partial_json === "string") {
      const tb = state.toolBlocks.get(idx);
      if (!tb) {
        failStream(state, "malformed_tool_input", "Qoder sent tool input for a block that was not started");
        return;
      }
      if (tb.input.length + delta.partial_json.length > MAX_TOOL_INPUT_CHARS) {
        failStream(state, "tool_input_too_large", "Qoder sent a tool input larger than the bridge limit");
        return;
      }
      tb.hasInput = true;
      tb.input += delta.partial_json;
      if (!tb.providerExecuted) {
        safeEnqueue(controller, { type: "tool-input-delta", id: tb.id, delta: delta.partial_json });
      }
    } else if (deltaType === "input_json_delta") {
      failStream(state, "malformed_tool_input", "Qoder sent a tool input delta without JSON text");
    } else {
      failStream(state, "malformed_stream", "Qoder sent an unsupported content block delta");
    }
    return;
  }

  if (evType === "content_block_delta") {
    failStream(state, "malformed_stream", "Qoder sent a content block delta without a delta object");
    return;
  }

  if (evType === "content_block_stop") {
    const tb = state.toolBlocks.get(idx);
    if (tb) {
      if (!tb.hasInput) {
        failStream(state, "malformed_tool_input", `Qoder closed tool ${tb.name} without input JSON`);
        return;
      }
      if (!state.pendingToolCalls.has(tb.id) && !tb.providerExecuted) {
        const input = normalizedToolInput(tb.name, tb.input);
        if (input === null) {
          failStream(state, "invalid_tool_input", `Qoder sent invalid JSON for tool ${tb.name}`);
          return;
        }
        safeEnqueue(controller, { type: "tool-input-end", id: tb.id });
        safeEnqueue(controller, { type: "tool-call", toolCallId: tb.id, toolName: tb.name, input });
        state.emittedToolCall = true;
      }
      if (!state.pendingToolCalls.has(tb.id)) {
        state.pendingToolCalls.set(tb.id, { name: tb.name, providerExecuted: tb.providerExecuted });
      }
      state.toolBlocks.delete(idx);
      untrackOpenBlock(state, idx);
    } else if (state.activeReasoning.has(idx)) {
      safeEnqueue(controller, { type: "reasoning-end", id: String(idx) });
      state.activeReasoning.delete(idx);
      untrackOpenBlock(state, idx);
    } else if (state.activeText.has(idx)) {
      safeEnqueue(controller, { type: "text-end", id: String(idx) });
      state.activeText.delete(idx);
      untrackOpenBlock(state, idx);
    } else {
      failStream(state, "malformed_stream", "Qoder stopped a content block that was not started");
    }
    return;
  }

  if (evType === "message_delta" && isRecord(ev.delta) && typeof ev.delta.stop_reason === "string") {
    state.lastStopReason = safeStopReason(ev.delta.stop_reason);
  }
}

function handleAssistant(m: Record<string, unknown>, state: StreamState): void {
  if (isAuthenticationError(m.error)) {
    state.authExpired = true;
    return;
  }
  const message = m.message as Record<string, unknown> | undefined;
  if (Object.hasOwn(message ?? {}, "stop_reason")) state.lastStopReason = safeStopReason(message?.stop_reason);
  const content = message?.content;
  if (!Array.isArray(content)) {
    failStream(state, "malformed_stream", "Qoder sent an assistant message without content");
    return;
  }
  const { controller } = state;

  for (const raw of content) {
    if (!isRecord(raw)) {
      failStream(state, "malformed_stream", "Qoder sent an assistant content block that was not an object");
      break;
    }
    const blockType = raw.type as string;

    if (blockType === "text" && typeof raw.text === "string" && raw.text && !state.sawStreamText) {
      if (!appendOutput(state, raw.text)) break;
      const id = String(state.blockCounter++);
      safeEnqueue(controller, { type: "text-start", id });
      safeEnqueue(controller, { type: "text-delta", id, delta: raw.text });
      safeEnqueue(controller, { type: "text-end", id });
    } else if (blockType === "thinking" && typeof raw.thinking === "string" && raw.thinking && !state.sawStreamReasoning) {
      if (!appendOutput(state, raw.thinking)) break;
      const id = String(state.blockCounter++);
      safeEnqueue(controller, { type: "reasoning-start", id });
      safeEnqueue(controller, { type: "reasoning-delta", id, delta: raw.thinking });
      safeEnqueue(controller, { type: "reasoning-end", id });
    } else if (blockType === "tool_use" && typeof raw.id === "string" && raw.id.trim() && typeof raw.name === "string" && raw.name.trim()) {
      const seenToolCallIds = state.seenToolCallIds ??= new Set();
      if (!rememberId(seenToolCallIds, raw.id, MAX_SEEN_MESSAGE_IDS)) continue;
      const name = normalizeToolName(raw.name);
      const providerExecuted = isProviderOwnedTool(raw.name, name, state.functionToolNames);
      state.pendingToolCalls.set(raw.id, { name, providerExecuted });
      if (!providerExecuted) {
        const input = normalizedToolInput(name, raw.input);
        if (input === null) {
          failStream(state, "invalid_tool_input", `Qoder sent invalid JSON for tool ${name}`);
          break;
        }
        safeEnqueue(controller, { type: "tool-input-start", id: raw.id, toolName: name });
        safeEnqueue(controller, { type: "tool-input-delta", id: raw.id, delta: input });
        safeEnqueue(controller, { type: "tool-input-end", id: raw.id });
        safeEnqueue(controller, { type: "tool-call", toolCallId: raw.id, toolName: name, input });
        state.emittedToolCall = true;
      }
    } else if (blockType === "tool_use") {
      failStream(state, "malformed_tool_call", "Qoder sent a tool call without a valid id or name");
      break;
    }
  }
}

function normalizedToolInput(toolName: string, raw: unknown): string | null {
  if (raw === undefined) return null;
  const serialized = typeof raw === "string" ? raw : safeJsonStringify(raw);
  if (serialized === undefined || serialized.length > MAX_TOOL_INPUT_CHARS) return null;
  try {
    const parsed = JSON.parse(serialized.trim() || "{}");
    if (!isRecord(parsed)) return null;
    return normalizeToolInputString(toolName, serialized);
  } catch {
    return null;
  }
}

function appendOutput(state: StreamState, text: string): boolean {
  const current = Number.isFinite(state.outputChars) ? state.outputChars : 0;
  if (current + text.length > MAX_OUTPUT_CHARS) {
    failStream(state, "output_too_large", "Qoder sent more output than the bridge limit");
    return false;
  }
  state.outputChars = current + text.length;
  return true;
}

function failStream(state: StreamState, subtype: string, detail: string): void {
  if (state.finished) return;
  state.failed = true;
  closeOpenBlocks(state);
  safeEnqueue(state.controller, { type: "error", error: new QoderSdkResultError(subtype, detail) });
  emitFinish(state, makeUsage(0, 0, 0, 0), makeFinishReason("error", subtype), undefined);
}

function handleResult(m: Record<string, unknown>, state: StreamState): void {
  state.resultReceived = true;
  const { controller } = state;

  if (Object.hasOwn(m, "stop_reason")) {
    state.lastStopReason = safeStopReason(m.stop_reason);
  }

  if (state.activeReasoning.size > 0 || state.activeText.size > 0 || state.toolBlocks.size > 0) {
    state.failed = true;
    closeOpenBlocks(state);
    safeEnqueue(controller, {
      type: "error",
      error: new QoderSdkResultError("incomplete_stream", "Qoder sent a result before closing all content blocks"),
    });
    emitFinish(state, makeUsage(0, 0, 0, 0), makeFinishReason("error", "incomplete_stream"), undefined);
    return;
  }

  closeOpenBlocks(state);

  const usage = isRecord(m.usage) ? m.usage : {};
  let inputTokens = tokenCount(usage.input_tokens);
  let outputTokens = tokenCount(usage.output_tokens);
  const cachedInputTokens = tokenCount(usage.cache_read_input_tokens);
  const cacheWriteTokens = tokenCount(usage.cache_creation_input_tokens);
  const contextUsageRatio = ratio(usage.context_usage_ratio);
  let usageEstimated = false;

  // Qoder's first-party backend currently reports zero token counters, but it
  // does report the fraction of the context window used. Convert that ratio
  // into a best-effort AI SDK usage value so OpenCode can update its Context
  // panel instead of permanently displaying 0 tokens / 0%.
  if (
    inputTokens === 0
    && outputTokens === 0
    && contextUsageRatio !== undefined
    && contextUsageRatio > 0
  ) {
    const totalTokens = Math.max(1, Math.round(contextUsageRatio * state.contextWindow));
    const resultText = typeof m.result === "string" ? m.result : "";
    outputTokens = resultText ? Math.max(1, Math.ceil(Buffer.byteLength(resultText, "utf8") / 4)) : 0;
    outputTokens = Math.min(outputTokens, totalTokens);
    inputTokens = totalTokens - outputTokens;
    usageEstimated = true;
    debug(`Token counters absent; estimated ${inputTokens} in / ${outputTokens} out from context ratio`);
  }

  const costUsd = finiteNonNegative(m.total_cost_usd);
  const model = typeof m.model === "string" && m.model.trim() ? m.model : "unknown";
  const durationMs = finiteNonNegative(m.duration_ms);
  const turns = finiteNonNegative(m.num_turns, 1);
  const record = () => {
    try {
      recordTurn({
        model,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cachedInputTokens,
          cache_creation_input_tokens: cacheWriteTokens,
        },
        costUsd,
        durationMs,
        turns,
      });
    } catch (err) {
      debug("Cost ledger write skipped:", describeError(err));
    }
  };

  const isAuthError = state.authExpired;
  const subtype = isAuthError
    ? "authentication_failed"
    : typeof m.subtype === "string" ? m.subtype : "error_during_execution";
  const isError = isAuthError || m.is_error === true || m.subtype !== "success";
  if (isError) {
    state.failed = true;
    const detail = Array.isArray(m.errors)
      ? redactSensitiveText((safeJsonStringify(m.errors) ?? "").slice(0, 4096))
      : "";
    state.invalidSession = isInvalidSessionError(subtype, detail);
    const error = state.authExpired
      ? new QoderAuthError("Qoder authentication expired during the request. Re-authenticate with `qoder login` or refresh QODER_PERSONAL_ACCESS_TOKEN.")
      : new QoderSdkResultError(subtype, detail);
    record();
    safeEnqueue(controller, { type: "error", error });
    emitFinish(state, makeUsage(inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens), makeFinishReason("error", subtype), undefined);
    return;
  }
  const hasToolCalls = state.emittedToolCall && state.pendingToolCalls.size > 0;
  const finishReason = mapStopReason(state.lastStopReason, hasToolCalls);
  record();

  const qoderMeta: Record<string, JsonValue> = {};
  if (Number.isFinite(costUsd)) qoderMeta.totalCostUSD = costUsd;
  const modelUsage = toJsonValue(m.modelUsage);
  if (modelUsage !== undefined) qoderMeta.modelUsage = modelUsage;
  if (contextUsageRatio !== undefined) qoderMeta.contextUsageRatio = contextUsageRatio;
  if (usageEstimated) qoderMeta.usageEstimated = true;
  const planMode = toJsonValue(state.planMode);
  if (planMode !== undefined) qoderMeta.planMode = planMode;
  const artifacts = toJsonValue(state.artifacts);
  if (artifacts !== undefined && state.artifacts.length > 0) qoderMeta.artifacts = artifacts;
  const skillEvolution = toJsonValue(state.skillEvolution);
  if (skillEvolution !== undefined) qoderMeta.skillEvolution = skillEvolution;

  emitFinish(
    state,
    makeUsage(inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens),
    finishReason,
    Object.keys(qoderMeta).length > 0 ? qoderMeta : undefined,
  );
}

function isInvalidSessionError(subtype: string, detail: string): boolean {
  return /(?:session.*(?:invalid|not[_ ]found|missing|expired)|(?:invalid|unknown|missing).*session)/i.test(`${subtype} ${detail}`);
}

function isLikelyInvalidSessionError(error: unknown): boolean {
  const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return isInvalidSessionError("", detail);
}

function emitFinish(
  state: StreamState,
  usage: LanguageModelV3Usage,
  finishReason: LanguageModelV3FinishReason,
  qoderMeta: Record<string, JsonValue> | undefined,
): void {
  if (state.finished) return;
  state.finished = true;
  closeOpenBlocks(state);
  safeEnqueue(state.controller, {
    type: "finish",
    finishReason,
    usage,
    ...(qoderMeta ? { providerMetadata: { qoder: qoderMeta } } : {}),
  });
}

function closeOpenBlocks(state: StreamState): void {
  for (const block of state.openBlocks ?? []) {
    if (block.kind === "reasoning") {
      safeEnqueue(state.controller, { type: "reasoning-end", id: String(block.index) });
    } else if (block.kind === "text") {
      safeEnqueue(state.controller, { type: "text-end", id: String(block.index) });
    } else if (block.kind === "tool" && !block.providerExecuted) {
      safeEnqueue(state.controller, { type: "tool-input-end", id: block.id });
    }
  }
  state.openBlocks.length = 0;
  state.activeReasoning.clear();
  state.activeText.clear();
  state.toolBlocks.clear();
}
