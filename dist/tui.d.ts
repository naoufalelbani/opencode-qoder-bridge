import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import type { QoderCommandContext } from "./command-actions.js";
/**
 * Render-path reads must never throw: the plugin API can go stale after a
 * host reload while Solid effects/timers still reference it. A stale read
 * degrades to "not qoder" / zero instead of crashing the sidebar.
 */
export declare function safeApiRead<T>(fallback: T, read: () => T): T;
export declare const id = "opencode-qoder-bridge-sidebar";
type TuiApi = Parameters<TuiPlugin>[0];
export declare function registerInstantCommands(api: TuiApi, context: QoderCommandContext): void;
export declare const tui: TuiPlugin;
declare const _default: {
    id: string;
    tui: TuiPlugin;
};
export default _default;
//# sourceMappingURL=tui.d.ts.map