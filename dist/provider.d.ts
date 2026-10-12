import { QoderLanguageModel } from "./language-model.js";
import type { QoderBridgeOptions } from "./types.js";
/**
 * OpenCode 2's non-`aisdk:` provider loader imports `package` and calls its
 * named `model(modelID, settings)` export. Settings are
 * `providers.qoder.settings` merged with the connection credentials.
 */
export declare function model(modelID: string, settings?: QoderBridgeOptions): QoderLanguageModel;
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