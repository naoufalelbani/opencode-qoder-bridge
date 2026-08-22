import { homedir } from "node:os";
import { join } from "node:path";
/**
 * Single source of truth for the bridge's on-disk state directory.
 * Precedence: QODER_BRIDGE_STATE_DIR > XDG_CONFIG_HOME > ~/.config.
 */
export function resolveStateDir(env = process.env) {
    const override = env.QODER_BRIDGE_STATE_DIR?.trim();
    if (override)
        return join(override);
    const configHome = env.XDG_CONFIG_HOME?.trim();
    return join(configHome || join(homedir(), ".config"), "opencode-qoder-bridge");
}
//# sourceMappingURL=state-dir.js.map