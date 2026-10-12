import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { getLiveUsage } from "./usage.js";
import { QODER_COMMANDS } from "./command-actions.js";
import type { QoderCommandContext } from "./command-actions.js";
export type QuotaView = {
    used?: number;
    total?: number;
    remaining?: number;
    percent?: number;
    error?: string;
    warning: boolean;
};
export declare function formatCredits(value: number): string;
export declare function formatSessionCredits(value: number): string;
/**
 * Render-path reads must never throw: the plugin API can go stale after a
 * host reload while Solid effects/timers still reference it. A stale read
 * degrades to "not qoder" / zero instead of crashing the sidebar.
 */
export declare function safeApiRead<T>(fallback: T, read: () => T): T;
export declare function formatQuota(usage: Awaited<ReturnType<typeof getLiveUsage>>): QuotaView;
export declare const id = "opencode-qoder-bridge-sidebar";
type TuiApi = Parameters<TuiPlugin>[0];
/**
 * Keep every command registered so direct dispatch and the tool surface stay
 * intact, but hide commands whose prerequisites are not present from the
 * OpenCode command palette. `hidden` is intentionally separate from
 * `enabled`: hidden commands are not disabled.
 */
export declare function shouldHideCommand(command: (typeof QODER_COMMANDS)[number], context: QoderCommandContext): boolean;
export declare function registerInstantCommands(api: TuiApi, context: QoderCommandContext): void;
export declare const tui: TuiPlugin;
/**
 * OpenCode 2 entry point. The V2 sidebar lives in `tui-v2.ts` so OpenCode 1
 * never evaluates the V2 plugin package; the guard keeps one sidebar alive when
 * OpenCode 2 hands this module to both the CLI-plugin loader and the migrated
 * `tui.json` entry.
 */
export declare function setup(context: unknown): Promise<(() => Promise<void> | void) | void>;
declare const _default: {
    id: string;
    tui: TuiPlugin;
    setup: typeof setup;
};
export default _default;
//# sourceMappingURL=tui.d.ts.map