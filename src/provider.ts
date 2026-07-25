import { QoderLanguageModel } from "./language-model.js";
import type { QoderBridgeOptions } from "./types.js";

/**
 * Provider factory consumed by opencode's `npm` provider loader.
 * opencode calls `createQoderProvider(options)` then `.languageModel(modelId)`.
 */
export function createQoderProvider(options: QoderBridgeOptions = {}) {
  return {
    languageModel: (modelId: string) => new QoderLanguageModel(modelId, options),
    textEmbeddingModel: (_modelId: string): never => {
      throw new Error("Qoder provider does not support text embeddings");
    },
    imageModel: (_modelId: string): never => {
      throw new Error("Qoder provider does not support image generation");
    },
  };
}
