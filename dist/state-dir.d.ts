/**
 * Single source of truth for the bridge's on-disk state directory.
 * Precedence: QODER_BRIDGE_STATE_DIR > XDG_CONFIG_HOME > ~/.config.
 */
export declare function resolveStateDir(env?: NodeJS.ProcessEnv): string;
//# sourceMappingURL=state-dir.d.ts.map