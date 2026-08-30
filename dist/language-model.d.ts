import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3StreamResult } from "@ai-sdk/provider";
import type { SDKArtifactInfo, SDKPlanModeSnapshot } from "@qoder-ai/qoder-agent-sdk";
import type { ModelDiscoveryOptions } from "./models.js";
import type { QoderBridgeOptions } from "./types.js";
type StreamController = ReadableStreamDefaultController<LanguageModelV3StreamPart>;
type OpenBlock = {
    kind: "reasoning" | "text";
    index: number;
} | {
    kind: "tool";
    index: number;
    id: string;
    providerExecuted: boolean;
};
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
        hasInput: boolean;
    }>;
    openBlocks: OpenBlock[];
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
    modelEnvironment?: Record<string, string | undefined>;
    modelDiscoveryOptions?: ModelDiscoveryOptions;
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