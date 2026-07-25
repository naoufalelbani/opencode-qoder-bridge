import { randomUUID } from "node:crypto";
import { query, qodercliAuth } from "@qoder-ai/qoder-agent-sdk";
import { getModel, DEFAULT_MODEL_ID } from "./models.js";
import { findQoderCLI } from "./auth.js";
import { buildPromptString, buildPromptIterable, promptHasImage } from "./prompt-builder.js";
import { normalizeToolName, normalizeToolInputString } from "./tool-normalizer.js";
import { recordTurn } from "./cost.js";
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function makeFinishReason(unified, raw) {
    return { unified, raw };
}
function makeUsage(input, output, cacheRead, cacheWrite) {
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
function mapStopReason(stopReason, hasToolCalls) {
    if (hasToolCalls)
        return makeFinishReason("tool-calls", stopReason ?? undefined);
    switch (stopReason) {
        case "max_tokens":
            return makeFinishReason("length", stopReason);
        case "refusal":
            return makeFinishReason("content-filter", stopReason);
        default:
            return makeFinishReason("stop", stopReason ?? undefined);
    }
}
export function isProviderExecutedTool(name, functionToolNames) {
    return !functionToolNames.has(name);
}
export class QoderLanguageModel {
    specificationVersion = "v3";
    provider = "qoder";
    modelId;
    supportedUrls = {};
    bridgeOptions;
    constructor(modelId, bridgeOptions = {}) {
        this.modelId = modelId;
        this.bridgeOptions = bridgeOptions;
    }
    async doGenerate(options) {
        const { stream } = await this.doStream(options);
        const reader = stream.getReader();
        let text = "";
        let reasoning = "";
        let finishReason = makeFinishReason("stop");
        let usage = makeUsage(0, 0, 0, 0);
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            switch (value.type) {
                case "text-delta":
                    text += value.delta;
                    break;
                case "reasoning-delta":
                    reasoning += value.delta;
                    break;
                case "finish":
                    finishReason = value.finishReason;
                    usage = value.usage;
                    break;
                case "error":
                    throw value.error instanceof Error ? value.error : new Error(String(value.error));
            }
        }
        const content = [];
        if (reasoning)
            content.push({ type: "reasoning", text: reasoning });
        if (text)
            content.push({ type: "text", text });
        return { content, finishReason, usage, warnings: [] };
    }
    async doStream(options) {
        const cli = findQoderCLI();
        if (!cli) {
            throw new Error("qodercli not found. Install Qoder CLI first: https://docs.qoder.com/cli");
        }
        const model = getModel(this.modelId) ?? getModel(DEFAULT_MODEL_ID);
        const sessionId = randomUUID();
        const promptMessages = options.prompt;
        const prompt = promptHasImage(promptMessages)
            ? buildPromptIterable(promptMessages, model.limit.context, sessionId)
            : buildPromptString(promptMessages, model.limit.context);
        const functionToolNames = new Set((options.tools ?? [])
            .filter((t) => t.type === "function")
            .map((t) => normalizeToolName(t.name)));
        const abortController = new AbortController();
        let qoderQuery = null;
        let cleaned = false;
        let externallyAborted = false;
        const cleanup = () => {
            if (cleaned)
                return;
            cleaned = true;
            abortController.abort();
            void qoderQuery?.return(undefined).catch(() => { });
        };
        const markExternal = () => {
            externallyAborted = true;
            cleanup();
        };
        if (options.abortSignal) {
            if (options.abortSignal.aborted)
                markExternal();
            else
                options.abortSignal.addEventListener("abort", markExternal, { once: true });
        }
        const qoderOptions = this.buildQueryOptions(cli, sessionId, abortController);
        const stream = new ReadableStream({
            cancel: markExternal,
            start: async (controller) => {
                const state = {
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
                    for await (const msg of qoderQuery) {
                        handleSdkMessage(msg, state);
                        if (state.finished)
                            break;
                    }
                    if (!state.finished) {
                        emitFinish(state, makeUsage(0, 0, 0, 0), makeFinishReason("stop"), undefined);
                    }
                    cleanup();
                    controller.close();
                }
                catch (err) {
                    cleanup();
                    if (externallyAborted && !state.finished) {
                        controller.close();
                        return;
                    }
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
    buildQueryOptions(cli, sessionId, abortController) {
        const opts = {
            auth: qodercliAuth(),
            model: this.modelId,
            pathToQoderCLIExecutable: cli,
            allowDangerouslySkipPermissions: true,
            permissionMode: "bypassPermissions",
            includePartialMessages: true,
            sessionId,
            cwd: process.cwd(),
            abortController,
        };
        const mcpServers = this.bridgeOptions.mcpServers;
        if (mcpServers && Object.keys(mcpServers).length > 0) {
            opts.mcpServers = mcpServers;
        }
        if (this.bridgeOptions.extraArgs && Object.keys(this.bridgeOptions.extraArgs).length > 0) {
            opts.extraArgs = this.bridgeOptions.extraArgs;
        }
        return opts;
    }
}
function handleSdkMessage(m, state) {
    const type = m.type;
    if (type === "stream_event") {
        handleStreamEvent(m.event, state);
    }
    else if (type === "assistant") {
        handleAssistant(m, state);
    }
    else if (type === "result") {
        handleResult(m, state);
    }
}
function handleStreamEvent(ev, state) {
    if (!ev)
        return;
    const { controller } = state;
    const evType = ev.type;
    const idx = typeof ev.index === "number" ? ev.index : 0;
    if (evType === "content_block_start" && isRecord(ev.content_block)) {
        const block = ev.content_block;
        const blockType = block.type;
        if (blockType === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            state.sawStreamTool = true;
            const name = normalizeToolName(block.name);
            const providerExecuted = isProviderExecutedTool(name, state.functionToolNames);
            state.toolBlocks.set(idx, { id: block.id, name, input: "", providerExecuted });
            if (!providerExecuted) {
                controller.enqueue({ type: "tool-input-start", id: block.id, toolName: name });
            }
        }
        else if (blockType === "thinking") {
            state.activeReasoning.add(idx);
            controller.enqueue({ type: "reasoning-start", id: String(idx) });
        }
        else if (blockType === "text") {
            state.activeText.add(idx);
            controller.enqueue({ type: "text-start", id: String(idx) });
        }
        return;
    }
    if (evType === "content_block_delta" && isRecord(ev.delta)) {
        const delta = ev.delta;
        const deltaType = delta.type;
        if (deltaType === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
            state.sawStreamReasoning = true;
            if (!state.activeReasoning.has(idx)) {
                state.activeReasoning.add(idx);
                controller.enqueue({ type: "reasoning-start", id: String(idx) });
            }
            controller.enqueue({ type: "reasoning-delta", id: String(idx), delta: delta.thinking });
        }
        else if (deltaType === "text_delta" && typeof delta.text === "string" && delta.text) {
            state.sawStreamText = true;
            if (!state.activeText.has(idx)) {
                state.activeText.add(idx);
                controller.enqueue({ type: "text-start", id: String(idx) });
            }
            controller.enqueue({ type: "text-delta", id: String(idx), delta: delta.text });
        }
        else if (deltaType === "input_json_delta" && typeof delta.partial_json === "string") {
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
        }
        else if (state.activeReasoning.has(idx)) {
            controller.enqueue({ type: "reasoning-end", id: String(idx) });
            state.activeReasoning.delete(idx);
        }
        else if (state.activeText.has(idx)) {
            controller.enqueue({ type: "text-end", id: String(idx) });
            state.activeText.delete(idx);
        }
        return;
    }
    if (evType === "message_delta" && isRecord(ev.delta) && typeof ev.delta.stop_reason === "string") {
        state.lastStopReason = ev.delta.stop_reason;
    }
}
function handleAssistant(m, state) {
    const message = m.message;
    const content = message?.content;
    if (!Array.isArray(content))
        return;
    const { controller } = state;
    for (const raw of content) {
        if (!isRecord(raw))
            continue;
        const blockType = raw.type;
        if (blockType === "text" && typeof raw.text === "string" && raw.text && !state.sawStreamText) {
            const id = String(state.blockCounter++);
            controller.enqueue({ type: "text-start", id });
            controller.enqueue({ type: "text-delta", id, delta: raw.text });
            controller.enqueue({ type: "text-end", id });
        }
        else if (blockType === "thinking" && typeof raw.thinking === "string" && raw.thinking && !state.sawStreamReasoning) {
            const id = String(state.blockCounter++);
            controller.enqueue({ type: "reasoning-start", id });
            controller.enqueue({ type: "reasoning-delta", id, delta: raw.thinking });
            controller.enqueue({ type: "reasoning-end", id });
        }
        else if (blockType === "tool_use" && typeof raw.id === "string" && typeof raw.name === "string" && !state.sawStreamTool) {
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
function handleResult(m, state) {
    const { controller } = state;
    for (const idx of state.activeReasoning)
        controller.enqueue({ type: "reasoning-end", id: String(idx) });
    state.activeReasoning.clear();
    for (const idx of state.activeText)
        controller.enqueue({ type: "text-end", id: String(idx) });
    state.activeText.clear();
    const isError = m.is_error === true || (typeof m.subtype === "string" && m.subtype !== "success");
    if (isError) {
        const subtype = typeof m.subtype === "string" ? m.subtype : "error_during_execution";
        const errors = Array.isArray(m.errors) ? JSON.stringify(m.errors) : "";
        controller.enqueue({ type: "error", error: new Error(`Qoder SDK: ${subtype}${errors ? ` | ${errors}` : ""}`) });
        emitFinish(state, makeUsage(0, 0, 0, 0), makeFinishReason("error", subtype), undefined);
        return;
    }
    const usage = (m.usage ?? {});
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
    if (inputTokens === 0
        && outputTokens === 0
        && typeof contextUsageRatio === "number"
        && Number.isFinite(contextUsageRatio)
        && contextUsageRatio > 0) {
        const totalTokens = Math.max(1, Math.round(Math.min(contextUsageRatio, 1) * state.contextWindow));
        const resultText = typeof m.result === "string" ? m.result : "";
        outputTokens = resultText ? Math.max(1, Math.ceil(Buffer.byteLength(resultText, "utf8") / 4)) : 0;
        outputTokens = Math.min(outputTokens, totalTokens);
        inputTokens = totalTokens - outputTokens;
        usageEstimated = true;
    }
    const costUsd = typeof m.total_cost_usd === "number" ? m.total_cost_usd : 0;
    const hasToolCalls = state.emittedToolCall && state.pendingToolCalls.size > 0;
    const finishReason = mapStopReason(state.lastStopReason, hasToolCalls);
    try {
        recordTurn({
            model: m.model ?? "unknown",
            usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_read_input_tokens: cachedInputTokens,
                cache_creation_input_tokens: cacheWriteTokens,
            },
            costUsd,
            durationMs: typeof m.duration_ms === "number" ? m.duration_ms : 0,
            turns: typeof m.num_turns === "number" ? m.num_turns : 1,
            modelUsage: m.modelUsage,
        });
    }
    catch {
        /* ledger is best-effort */
    }
    const qoderMeta = {};
    if (typeof m.total_cost_usd === "number")
        qoderMeta.totalCostUSD = m.total_cost_usd;
    if (isRecord(m.modelUsage))
        qoderMeta.modelUsage = m.modelUsage;
    if (typeof contextUsageRatio === "number")
        qoderMeta.contextUsageRatio = contextUsageRatio;
    if (usageEstimated)
        qoderMeta.usageEstimated = true;
    emitFinish(state, makeUsage(inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens), finishReason, Object.keys(qoderMeta).length > 0 ? { qoder: qoderMeta } : undefined);
}
function emitFinish(state, usage, finishReason, providerMetadata) {
    state.controller.enqueue({
        type: "finish",
        finishReason,
        usage,
        ...(providerMetadata ? { providerMetadata: { qoder: providerMetadata } } : {}),
    });
    state.finished = true;
}
//# sourceMappingURL=language-model.js.map