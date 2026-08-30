import type { ModelUsage } from "@qoder-ai/qoder-agent-sdk";
export interface TurnCost {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    durationMs: number;
    turns: number;
    at: number;
}
interface PersistedState {
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    turnCount: number;
    byModel: Record<string, {
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        turns: number;
    }>;
    recent: TurnCost[];
}
export declare function flushLedgerSync(): void;
export interface RecordInput {
    model: string;
    usage?: {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
    };
    costUsd: number;
    durationMs: number;
    turns: number;
    modelUsage?: Record<string, ModelUsage>;
}
/** Record a completed turn into the persistent ledger. */
export declare function recordTurn(input: RecordInput): TurnCost;
export interface UsageSummary {
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    turnCount: number;
    byModel: PersistedState["byModel"];
    recent: TurnCost[];
}
export declare function summarize(): UsageSummary;
export declare function resetLedger(): void;
export declare function formatCost(usd: number): string;
export {};
//# sourceMappingURL=cost.d.ts.map