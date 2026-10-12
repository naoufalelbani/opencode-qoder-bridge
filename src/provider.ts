import { QoderLanguageModel } from "./language-model.js";
import { UnsupportedCapabilityError } from "./errors.js";
import type { QoderBridgeOptions } from "./types.js";

/**
 * OpenCode 2's non-`aisdk:` provider loader imports `package` and calls its
 * named `model(modelID, settings)` export. Settings are
 * `providers.qoder.settings` merged with the connection credentials.
 */
export function model(modelID: string, settings: QoderBridgeOptions = {}): QoderLanguageModel {
  return new QoderLanguageModel(modelID, settings);
}

/**
 * Provider factory consumed by opencode's `npm` provider loader.
 * opencode calls `createQoderProvider(options)` then `.languageModel(modelId)`.
 */
export function createQoderProvider(options: QoderBridgeOptions = {}) {
  return {
    languageModel: (modelId: string) => new QoderLanguageModel(modelId, options),
    textEmbeddingModel: (_modelId: string): never => {
      throw new UnsupportedCapabilityError("text embeddings");
    },
    imageModel: (_modelId: string): never => {
      throw new UnsupportedCapabilityError("image generation");
    },
  };
}
