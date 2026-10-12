/**
 * OpenCode 2's TUI context is published by `@opencode/plugin/tui`. Declared
 * structurally here so the bridge does not need `@opencode/theme` (an optional
 * peer of `@opencode/plugin`) just to typecheck a sidebar.
 */
export interface TuiV2Context {
    readonly options: Readonly<Record<string, any>>;
    readonly location?: {
        readonly directory?: string;
    } | undefined;
    readonly theme: unknown;
    readonly data: {
        readonly on: (type: string, handler: (event: any) => void) => () => void;
        readonly session: {
            readonly get: (sessionID: string) => any;
            readonly cost: (sessionID: string) => number;
            readonly message: {
                readonly list: (sessionID: string) => readonly any[];
            };
        };
    };
    readonly keymap: {
        readonly layer: (factory: () => any) => void;
    };
    readonly ui: {
        readonly dialog: {
            readonly alert: (options: {
                readonly title: string;
                readonly message: string;
            }) => Promise<void>;
            readonly prompt: (options: {
                readonly title: string;
                readonly description?: string;
                readonly placeholder?: string;
                readonly value?: string;
            }) => Promise<string | undefined>;
        };
        readonly toast: {
            readonly show: (options: {
                readonly title?: string;
                readonly message: string;
                readonly variant?: string;
                readonly duration?: number;
            }) => void;
        };
        readonly router: {
            readonly current: () => {
                readonly type?: string;
                readonly sessionID?: string;
            };
        };
        readonly slot: (claim: {
            readonly append: "sidebar.content";
            readonly render: (input: {
                readonly sessionID: string;
            }) => unknown;
        }) => () => void;
    };
}
type TuiV2Plugin = {
    readonly id: string;
    readonly setup: (context: TuiV2Context) => Promise<(() => Promise<void> | void) | void> | (() => Promise<void> | void) | void;
};
export declare const id = "opencode-qoder-bridge-sidebar";
/**
 * OpenCode 2's sidebar. OpenCode 1 keeps loading `tui.ts`; OpenCode 2 loads
 * `./tui` automatically and runs this `setup` through the V2 TUI contract.
 */
export declare const tui: TuiV2Plugin;
declare const _default: TuiV2Plugin;
export default _default;
//# sourceMappingURL=tui-v2.d.ts.map