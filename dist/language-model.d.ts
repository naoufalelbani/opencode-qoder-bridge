import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult, LanguageModelV3StreamResult } from "@ai-sdk/provider";
import type { QoderBridgeOptions } from "./types.js";
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
//# sourceMappingURL=language-model.d.ts.map