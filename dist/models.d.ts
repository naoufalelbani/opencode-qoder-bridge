import { query, type ModelInfo } from "@qoder-ai/qoder-agent-sdk";
import type { QoderModelDef } from "./types.js";
export declare const FALLBACK_MODELS: QoderModelDef[];
export declare const DEFAULT_MODEL_ID = "auto";
export declare function getModel(id: string, environment?: Record<string, string | undefined>, options?: ModelDiscoveryOptions): QoderModelDef | undefined;
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
export interface ModelDiscoveryOptions {
    /** Effective environment for the SDK runtime. */
    environment?: Record<string, string | undefined>;
    /** SDK proxy and VPC settings, kept in parity with chat sessions. */
    proxy?: string;
    vpcEndpoint?: string;
    cwd?: string;
    /** Host-side deadline for live discovery. */
    timeoutMs?: number;
}
/** @internal Test seam for deterministic discovery lifecycle coverage. */
export declare function setModelDiscoveryQueryFactory(factory?: typeof query): void;
/**
 * Keep catalog entries that are usable model ids. Disabled entries are
 * dropped; anything else (BYOK, tagged, scene-filtered) stays so the bridge
 * never hides a model the server actually serves.
 */
export declare function selectEnabledModels(models: unknown): ModelInfo[];
/**
 * Dynamically apply live model updates received from SDK streaming events
 * (`available_models_update`). Updates the in-memory index and cache file.
 */
export declare function applyLiveModelUpdates(models: unknown, environment?: Record<string, string | undefined>, options?: ModelDiscoveryOptions): DynamicModelEntry[];
export declare function listModels(environment?: Record<string, string | undefined>, options?: ModelDiscoveryOptions): QoderModelDef[];
export declare function getCachedDynamicModels(environment?: Record<string, string | undefined>, options?: ModelDiscoveryOptions): DynamicModelEntry[] | null;
export declare function fetchDynamicModels(force?: boolean, environment?: Record<string, string | undefined>, options?: ModelDiscoveryOptions): Promise<DynamicModelEntry[] | null>;
export declare function queueModelCacheWrite(models: DynamicModelEntry[], environment?: Record<string, string | undefined>, options?: ModelDiscoveryOptions): Promise<void>;
export declare function flushModelCache(): Promise<void>;
//# sourceMappingURL=models.d.ts.map