import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import type { QoderCommandContext } from "./command-actions.js";
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