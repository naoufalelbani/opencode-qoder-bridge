import { type ModelInfo } from "@qoder-ai/qoder-agent-sdk";
import type { QoderModelDef } from "./types.js";
export declare const FALLBACK_MODELS: QoderModelDef[];
export declare const DEFAULT_MODEL_ID = "auto";
export declare function getModel(id: string): QoderModelDef | undefined;
export interface DynamicModelEntry {
    id: string;
    name: string;
    attachment: boolean;
    reasoning: boolean;
    toolCall: boolean;
    limit: {
        context: number;
        output: number;
    };
    cost: {
        input: number;
        output: number;
        cache_read: number;
        cache_write: number;
    };
    modalities: {
        input: string[];
        output: string[];
    };
}
/**
 * Keep catalog entries that are usable model ids. Disabled entries are
 * dropped; anything else (BYOK, tagged, scene-filtered) stays so the bridge
 * never hides a model the server actually serves.
 */
export declare function selectEnabledModels(models: ModelInfo[]): ModelInfo[];
export declare function listModels(): QoderModelDef[];
export declare function getCachedDynamicModels(): DynamicModelEntry[] | null;
export declare function fetchDynamicModels(force?: boolean): Promise<DynamicModelEntry[] | null>;
//# sourceMappingURL=models.d.ts.map