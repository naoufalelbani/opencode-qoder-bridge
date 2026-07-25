import { QoderLanguageModel } from "./language-model.js";
/**
 * Provider factory consumed by opencode's `npm` provider loader.
 * opencode calls `createQoderProvider(options)` then `.languageModel(modelId)`.
 */
export function createQoderProvider(options = {}) {
    return {
        languageModel: (modelId) => new QoderLanguageModel(modelId, options),
        textEmbeddingModel: (_modelId) => {
            throw new Error("Qoder provider does not support text embeddings");
        },
        imageModel: (_modelId) => {
            throw new Error("Qoder provider does not support image generation");
        },
    };
}
//# sourceMappingURL=provider.js.map