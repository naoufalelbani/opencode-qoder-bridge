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
export declare function fetchDynamicModels(): Promise<DynamicModelEntry[] | null>;
//# sourceMappingURL=models.d.ts.map