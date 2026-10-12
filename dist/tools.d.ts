import { z } from "zod";
import type { CommandResult, QoderCommandContext } from "./command-actions.js";
/**
 * Runtime-agnostic tool table.
 *
 * `src/index.ts` wraps these specs with OpenCode 1's `tool()` helper and
 * `src/v2.ts` converts them into OpenCode 2 `Tool.Info` entries. Both entry
 * points must expose the same names and descriptions; the test suite asserts
 * that parity so the two tables cannot drift.
 */
export interface QoderToolSpec {
    readonly name: string;
    readonly description: string;
    readonly args: z.ZodRawShape;
    readonly execute: (args: any, context: QoderCommandContext) => Promise<CommandResult>;
}
export declare function createQoderToolSpecs(context: () => QoderCommandContext): readonly QoderToolSpec[];
//# sourceMappingURL=tools.d.ts.map