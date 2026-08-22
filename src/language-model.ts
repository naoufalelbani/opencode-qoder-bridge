import { randomUUID } from "node:crypto";
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
import type { Options, Query } from "@qoder-ai/qoder-agent-sdk";
import { getModel, DEFAULT_MODEL_ID } from "./models.js";
import { findQoderCLI } from "./auth.js";
import { buildPromptString, buildPromptIterable, latestPrompt, promptHasImage } from "./prompt-builder.js";
import { normalizeToolName, normalizeToolInputString } from "./tool-normalizer.js";
import { recordTurn } from "./cost.js";
import type { QoderBridgeOptions } from "./types.js";
import { ensureQoderSession, getQoderSession } from "./session-store.js";
import { hasQoderPAT, qoderAuth } from "./sdk-auth.js";
import { QoderCliNotFoundError, QoderSdkResultError } from "./errors.js";
import { debug, describeError } from "./logger.js";

type StreamController = ReadableStreamDefaultController<LanguageModelV3StreamPart>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function makeFinishReason(
  unified: LanguageModelV3FinishReason["unified"],
  raw?: string,
): LanguageModelV3FinishReason {
  return { unified, raw };
}

function makeUsage(input: number, output: number, cacheRead: number, cacheWrite: number): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: input,
      noCache: Math.max(0, input - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: output,
      reasoning: undefined,
    },
  };
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

interface StreamState {
  controller: StreamController;
  contextWindow: number;
  functionToolNames: Set<string>;
  activeText: Set<number>;
  activeReasoning: Set<number>;
  toolBlocks: Map<number, { id: string; name: string; input: string; providerExecuted: boolean }>;
  sawStreamText: boolean;
  sawStreamTool: boolean;
  sawStreamReasoning: boolean;
  emittedToolCall: boolean;
  pendingToolCalls: Map<string, { name: string; providerExecuted: boolean }>;
  lastStopReason: string | null;
  blockCounter: number;
  finished: boolean;
}

export function isProviderExecutedTool(name: string, functionToolNames: ReadonlySet<string>): boolean {
  return !functionToolNames.has(name);
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
    const { stream } = await this.doStream(options);
    const reader = stream.getReader();

    let text = "";
    let reasoning = "";
    let finishReason: LanguageModelV3FinishReason = makeFinishReason("stop");
    let usage: LanguageModelV3Usage = makeUsage(0, 0, 0, 0);
    const toolCalls: Array<Extract<LanguageModelV3Content, { type: "tool-call" }>> = [];

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
          finishReason = value.finishReason;
          usage = value.usage;
          break;
        case "error":
          throw value.error instanceof Error ? value.error : new Error(String(value.error));
      }
    }

    const content: Array<LanguageModelV3Content> = [];
    if (reasoning) content.push({ type: "reasoning", text: reasoning });
    if (text) content.push({ type: "text", text });
    content.push(...toolCalls);

    return { content, finishReason, usage, warnings: [] };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const cli = findQoderCLI();
    if (!cli && !hasQoderPAT()) {
      throw new QoderCliNotFoundError();
    }

    const resolved = getModel(this.modelId) ?? getModel(DEFAULT_MODEL_ID)!;
    if (!getModel(this.modelId)) {
      debug(`Unknown model id "${this.modelId}"; falling back to "${resolved.id}"`);
    }
    const model = resolved;
    const sessionKey = this.bridgeOptions.sessionKey ?? this.bridgeOptions.sessionId;
    const persisted = this.bridgeOptions.sessionPersistence && sessionKey
      ? await getQoderSession(sessionKey)
      : null;
    const sessionId = this.bridgeOptions.sessionId ?? persisted?.qoderSessionId ?? randomUUID();
    const shouldResume = Boolean(this.bridgeOptions.sessionId || persisted);
    debug(`doStream model=${model.id} sessionId=${sessionId} resume=${shouldResume}`);
    const promptMessages = options.prompt as unknown as Array<{ role: string; content: unknown }>;
    const promptInput = shouldResume
      ? latestPrompt(promptMessages)
      : promptMessages;
    const prompt = promptHasImage(promptInput)
      ? buildPromptIterable(promptInput, model.limit.context, sessionId)
      : buildPromptString(promptInput, model.limit.context);

    const functionToolNames = new Set(
      (options.tools ?? [])
        .filter((t) => t.type === "function")
        .map((t) => normalizeToolName(t.name)),
    );

    const abortController = new AbortController();
    let qoderQuery: Query | null = null;
    let cleaned = false;
    let externallyAborted = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      abortController.abort();
      void qoderQuery?.return(undefined).catch(() => {});
    };
    const markExternal = () => {
      externallyAborted = true;
      cleanup();
    };

    if (options.abortSignal) {
      if (options.abortSignal.aborted) markExternal();
      else options.abortSignal.addEventListener("abort", markExternal, { once: true });
    }

    const qoderOptions = this.buildQueryOptions(cli, sessionId, abortController, shouldResume);

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
          sawStreamText: false,
          sawStreamTool: false,
          sawStreamReasoning: false,
          emittedToolCall: false,
          pendingToolCalls: new Map(),
          lastStopReason: null,
          blockCounter: 0,
          finished: false,
        };

        controller.enqueue({ type: "stream-start", warnings: [] });

        try {
          qoderQuery = query({ prompt, options: qoderOptions });
          if (this.bridgeOptions.sessionPersistence && sessionKey) {
            await ensureQoderSession(sessionKey, sessionId, process.cwd());
          }
          for await (const msg of qoderQuery) {
            handleSdkMessage(msg as Record<string, unknown>, state);
            if (state.finished) break;
          }

          if (!state.finished) {
            emitFinish(state, makeUsage(0, 0, 0, 0), makeFinishReason("stop"), undefined);
          }
          cleanup();
          controller.close();
        } catch (err) {
          cleanup();
          if (externallyAborted && !state.finished) {
            debug("Stream aborted by caller; closing without finish");
            controller.close();
            return;
          }
          debug("Stream failed:", describeError(err));
          if (!state.finished) {
            controller.enqueue({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
            emitFinish(state, makeUsage(0, 0, 0, 0), makeFinishReason("error"), undefined);
          }
          controller.close();
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
  ): Options {
    const sessionKey = this.bridgeOptions.sessionKey ?? this.bridgeOptions.sessionId;
    const permissionMode = this.bridgeOptions.permissionMode ?? "default";
    const opts: Options = {
      auth: qoderAuth(),
      model: this.modelId,
      allowDangerouslySkipPermissions: this.bridgeOptions.allowDangerouslySkipPermissions
        ?? (permissionMode === "bypassPermissions" ? true : undefined),
      permissionMode,
      includePartialMessages: true,
      sessionId,
      cwd: process.cwd(),
      abortController,
    };

    if (cli) opts.pathToQoderCLIExecutable = cli;
    if (this.bridgeOptions.env) opts.env = this.bridgeOptions.env;

    if ((this.bridgeOptions.sessionId || (this.bridgeOptions.sessionPersistence && sessionKey)) && shouldResume) {
      opts.resume = sessionId;
      opts.persistSession = true;
    }
    if (this.bridgeOptions.allowedTools) opts.allowedTools = this.bridgeOptions.allowedTools;
    if (this.bridgeOptions.disallowedTools) opts.disallowedTools = this.bridgeOptions.disallowedTools;

    const mcpServers = this.bridgeOptions.mcpServers;
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      opts.mcpServers = mcpServers as Options["mcpServers"];
    }
    if (this.bridgeOptions.extraArgs && Object.keys(this.bridgeOptions.extraArgs).length > 0) {
      opts.extraArgs = this.bridgeOptions.extraArgs;
    }
    return opts;
  }
}

export function handleSdkMessage(m: Record<string, unknown>, state: StreamState): void {
  const type = m.type as string;
  if (type === "stream_event") {
    handleStreamEvent(m.event as Record<string, unknown>, state);
  } else if (type === "assistant") {
    handleAssistant(m, state);
  } else if (type === "result") {
    handleResult(m, state);
  }
}

function handleStreamEvent(ev: Record<string, unknown> | undefined, state: StreamState): void {
  if (!ev) return;
  const { controller } = state;
  const evType = ev.type as string;
  const idx = typeof ev.index === "number" ? ev.index : 0;

  if (evType === "content_block_start" && isRecord(ev.content_block)) {
    const block = ev.content_block;
    const blockType = block.type as string;
    if (blockType === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      state.sawStreamTool = true;
      const name = normalizeToolName(block.name);
      const providerExecuted = isProviderExecutedTool(name, state.functionToolNames);
      state.toolBlocks.set(idx, { id: block.id, name, input: "", providerExecuted });
      if (!providerExecuted) {
        controller.enqueue({ type: "tool-input-start", id: block.id, toolName: name });
      }
    } else if (blockType === "thinking") {
      state.activeReasoning.add(idx);
      controller.enqueue({ type: "reasoning-start", id: String(idx) });
    } else if (blockType === "text") {
      state.activeText.add(idx);
      controller.enqueue({ type: "text-start", id: String(idx) });
    }
    return;
  }

  if (evType === "content_block_delta" && isRecord(ev.delta)) {
    const delta = ev.delta;
    const deltaType = delta.type as string;
    if (deltaType === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
      state.sawStreamReasoning = true;
      if (!state.activeReasoning.has(idx)) {
        state.activeReasoning.add(idx);
        controller.enqueue({ type: "reasoning-start", id: String(idx) });
      }
      controller.enqueue({ type: "reasoning-delta", id: String(idx), delta: delta.thinking });
    } else if (deltaType === "text_delta" && typeof delta.text === "string" && delta.text) {
      state.sawStreamText = true;
      if (!state.activeText.has(idx)) {
        state.activeText.add(idx);
        controller.enqueue({ type: "text-start", id: String(idx) });
      }
      controller.enqueue({ type: "text-delta", id: String(idx), delta: delta.text });
    } else if (deltaType === "input_json_delta" && typeof delta.partial_json === "string") {
      const tb = state.toolBlocks.get(idx);
      if (tb) {
        tb.input += delta.partial_json;
        if (!tb.providerExecuted) {
          controller.enqueue({ type: "tool-input-delta", id: tb.id, delta: delta.partial_json });
        }
      }
    }
    return;
  }

  if (evType === "content_block_stop") {
    const tb = state.toolBlocks.get(idx);
    if (tb) {
      if (!tb.providerExecuted) {
        const input = normalizeToolInputString(tb.name, tb.input);
        controller.enqueue({ type: "tool-input-end", id: tb.id });
        controller.enqueue({ type: "tool-call", toolCallId: tb.id, toolName: tb.name, input });
        state.emittedToolCall = true;
      }
      state.pendingToolCalls.set(tb.id, { name: tb.name, providerExecuted: tb.providerExecuted });
      state.toolBlocks.delete(idx);
    } else if (state.activeReasoning.has(idx)) {
      controller.enqueue({ type: "reasoning-end", id: String(idx) });
      state.activeReasoning.delete(idx);
    } else if (state.activeText.has(idx)) {
      controller.enqueue({ type: "text-end", id: String(idx) });
      state.activeText.delete(idx);
    }
    return;
  }

  if (evType === "message_delta" && isRecord(ev.delta) && typeof ev.delta.stop_reason === "string") {
    state.lastStopReason = ev.delta.stop_reason;
  }
}

function handleAssistant(m: Record<string, unknown>, state: StreamState): void {
  const message = m.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return;
  const { controller } = state;

  for (const raw of content) {
    if (!isRecord(raw)) continue;
    const blockType = raw.type as string;

    if (blockType === "text" && typeof raw.text === "string" && raw.text && !state.sawStreamText) {
      const id = String(state.blockCounter++);
      controller.enqueue({ type: "text-start", id });
      controller.enqueue({ type: "text-delta", id, delta: raw.text });
      controller.enqueue({ type: "text-end", id });
    } else if (blockType === "thinking" && typeof raw.thinking === "string" && raw.thinking && !state.sawStreamReasoning) {
      const id = String(state.blockCounter++);
      controller.enqueue({ type: "reasoning-start", id });
      controller.enqueue({ type: "reasoning-delta", id, delta: raw.thinking });
      controller.enqueue({ type: "reasoning-end", id });
    } else if (blockType === "tool_use" && typeof raw.id === "string" && typeof raw.name === "string" && !state.sawStreamTool) {
      const name = normalizeToolName(raw.name);
      const providerExecuted = isProviderExecutedTool(name, state.functionToolNames);
      state.pendingToolCalls.set(raw.id, { name, providerExecuted });
      if (!providerExecuted) {
        const rawInput = typeof raw.input === "string" ? raw.input : JSON.stringify(raw.input ?? {});
        const input = normalizeToolInputString(name, rawInput);
        controller.enqueue({ type: "tool-input-start", id: raw.id, toolName: name });
        controller.enqueue({ type: "tool-input-delta", id: raw.id, delta: input });
        controller.enqueue({ type: "tool-input-end", id: raw.id });
        controller.enqueue({ type: "tool-call", toolCallId: raw.id, toolName: name, input });
        state.emittedToolCall = true;
      }
    }
  }
}

function handleResult(m: Record<string, unknown>, state: StreamState): void {
  const { controller } = state;

  for (const idx of state.activeReasoning) controller.enqueue({ type: "reasoning-end", id: String(idx) });
  state.activeReasoning.clear();
  for (const idx of state.activeText) controller.enqueue({ type: "text-end", id: String(idx) });
  state.activeText.clear();

  const isError = m.is_error === true || (typeof m.subtype === "string" && m.subtype !== "success");
  if (isError) {
    const subtype = typeof m.subtype === "string" ? m.subtype : "error_during_execution";
    const errors = Array.isArray(m.errors) ? JSON.stringify(m.errors) : "";
    controller.enqueue({ type: "error", error: new QoderSdkResultError(subtype, errors) });
    emitFinish(state, makeUsage(0, 0, 0, 0), makeFinishReason("error", subtype), undefined);
    return;
  }

  const usage = (m.usage ?? {}) as Record<string, number | undefined>;
  let inputTokens = usage.input_tokens ?? 0;
  let outputTokens = usage.output_tokens ?? 0;
  const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const contextUsageRatio = usage.context_usage_ratio;
  let usageEstimated = false;

  // Qoder's first-party backend currently reports zero token counters, but it
  // does report the fraction of the context window used. Convert that ratio
  // into a best-effort AI SDK usage value so OpenCode can update its Context
  // panel instead of permanently displaying 0 tokens / 0%.
  if (
    inputTokens === 0
    && outputTokens === 0
    && typeof contextUsageRatio === "number"
    && Number.isFinite(contextUsageRatio)
    && contextUsageRatio > 0
  ) {
    const totalTokens = Math.max(1, Math.round(Math.min(contextUsageRatio, 1) * state.contextWindow));
    const resultText = typeof m.result === "string" ? m.result : "";
    outputTokens = resultText ? Math.max(1, Math.ceil(Buffer.byteLength(resultText, "utf8") / 4)) : 0;
    outputTokens = Math.min(outputTokens, totalTokens);
    inputTokens = totalTokens - outputTokens;
    usageEstimated = true;
    debug(`Token counters absent; estimated ${inputTokens} in / ${outputTokens} out from context ratio`);
  }
  const costUsd = typeof m.total_cost_usd === "number" ? m.total_cost_usd : 0;
  const hasToolCalls = state.emittedToolCall && state.pendingToolCalls.size > 0;
  const finishReason = mapStopReason(state.lastStopReason, hasToolCalls);

  try {
    recordTurn({
      model: (m as Record<string, unknown>).model as string | undefined ?? "unknown",
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cachedInputTokens,
        cache_creation_input_tokens: cacheWriteTokens,
      },
      costUsd,
      durationMs: typeof m.duration_ms === "number" ? m.duration_ms : 0,
      turns: typeof m.num_turns === "number" ? m.num_turns : 1,
      modelUsage: m.modelUsage as Record<string, never> | undefined,
    });
  } catch (err) {
    debug("Cost ledger write skipped:", describeError(err));
  }

  const qoderMeta: Record<string, JsonValue> = {};
  if (typeof m.total_cost_usd === "number") qoderMeta.totalCostUSD = m.total_cost_usd;
  if (isRecord(m.modelUsage)) qoderMeta.modelUsage = m.modelUsage as unknown as JsonValue;
  if (typeof contextUsageRatio === "number") qoderMeta.contextUsageRatio = contextUsageRatio;
  if (usageEstimated) qoderMeta.usageEstimated = true;

  emitFinish(
    state,
    makeUsage(inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens),
    finishReason,
    Object.keys(qoderMeta).length > 0 ? qoderMeta : undefined,
  );
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function emitFinish(
  state: StreamState,
  usage: LanguageModelV3Usage,
  finishReason: LanguageModelV3FinishReason,
  qoderMeta: Record<string, JsonValue> | undefined,
): void {
  state.controller.enqueue({
    type: "finish",
    finishReason,
    usage,
    ...(qoderMeta ? { providerMetadata: { qoder: qoderMeta } } : {}),
  });
  state.finished = true;
}
