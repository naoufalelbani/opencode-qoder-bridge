import { QoderLanguageModel } from "./language-model.js";
import { UnsupportedCapabilityError } from "./errors.js";
/**
 * Provider factory consumed by opencode's `npm` provider loader.
 * opencode calls `createQoderProvider(options)` then `.languageModel(modelId)`.
 */
export function createQoderProvider(options = {}) {
    return {
        languageModel: (modelId) => new QoderLanguageModel(modelId, options),
        textEmbeddingModel: (_modelId) => {
            throw new UnsupportedCapabilityError("text embeddings");
        },
        imageModel: (_modelId) => {
            throw new UnsupportedCapabilityError("image generation");
        },
    };
}
//# sourceMappingURL=provider.js.map