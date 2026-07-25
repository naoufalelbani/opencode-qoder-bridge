import { QoderLanguageModel } from "./language-model.js";
import type { QoderBridgeOptions } from "./types.js";
/**
 * Provider factory consumed by opencode's `npm` provider loader.
 * opencode calls `createQoderProvider(options)` then `.languageModel(modelId)`.
 */
export declare function createQoderProvider(options?: QoderBridgeOptions): {
    languageModel: (modelId: string) => QoderLanguageModel;
    textEmbeddingModel: (_modelId: string) => never;
    imageModel: (_modelId: string) => never;
};
//# sourceMappingURL=provider.d.ts.map