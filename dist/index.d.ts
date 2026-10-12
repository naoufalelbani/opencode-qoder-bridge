import { type Plugin } from "@opencode-ai/plugin";
/**
 * One entry point serves both plugin generations.
 *
 * OpenCode 1 loads `default.server` (and requires that a module exporting both
 * `server` and `tui` never happens). OpenCode 2 reads `id` plus `setup` and
 * ignores `server`. The V2 implementation is imported lazily so OpenCode 1
 * never evaluates the V2 plugin package.
 */
interface DualEntryPoint {
    readonly id: string;
    readonly setup: (context: unknown) => Promise<unknown>;
    readonly server: Plugin;
}
declare const entryPoint: DualEntryPoint;
export default entryPoint;
//# sourceMappingURL=index.d.ts.map