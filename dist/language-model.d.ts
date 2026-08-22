import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3StreamResult } from "@ai-sdk/provider";
import type { QoderBridgeOptions } from "./types.js";
type StreamController = ReadableStreamDefaultController<LanguageModelV3StreamPart>;
interface StreamState {
    controller: StreamController;
    contextWindow: number;
    functionToolNames: Set<string>;
    activeText: Set<number>;
    activeReasoning: Set<number>;
    toolBlocks: Map<number, {
        id: string;
        name: string;
        input: string;
        providerExecuted: boolean;
    }>;
    sawStreamText: boolean;
    sawStreamTool: boolean;
    sawStreamReasoning: boolean;
    emittedToolCall: boolean;
    pendingToolCalls: Map<string, {
        name: string;
        providerExecuted: boolean;
    }>;
    lastStopReason: string | null;
    blockCounter: number;
    finished: boolean;
}
export declare function isProviderExecutedTool(name: string, functionToolNames: ReadonlySet<string>): boolean;
export declare class QoderLanguageModel implements LanguageModelV3 {
    readonly specificationVersion: "v3";
    readonly provider: "qoder";
    readonly modelId: string;
    readonly supportedUrls: Record<string, RegExp[]>;
    private readonly bridgeOptions;
    constructor(modelId: string, bridgeOptions?: QoderBridgeOptions);
    doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult>;
    doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult>;
    private buildQueryOptions;
}
export declare function handleSdkMessage(m: Record<string, unknown>, state: StreamState): void;
export {};
//# sourceMappingURL=language-model.d.ts.map