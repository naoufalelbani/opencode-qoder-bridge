import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
const TUI_ENTRY = new URL("./tui.js", import.meta.url).href;
const LOCK_STALE_MS = 120_000;
const LOCK_ATTEMPTS = 80;
function globalTuiConfigPath() {
    const explicit = process.env.OPENCODE_TUI_CONFIG?.trim();
    if (explicit)
        return explicit;
    const configDir = process.env.OPENCODE_CONFIG_DIR?.trim();
    if (configDir)
        return join(configDir, "tui.json");
    const configHome = process.env.XDG_CONFIG_HOME?.trim();
    return join(configHome || join(homedir(), ".config"), "opencode", "tui.json");
}
function isMissingFile(error) {
    return (error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT");
}
async function readConfig(path) {
    try {
        return await readFile(path, "utf8");
    }
    catch (error) {
        if (isMissingFile(error))
            return "";
        throw error;
    }
}
async function withConfigLock(configPath, fn) {
    const lockPath = `${configPath}.qoder-bridge.lock`;
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    try {
        await chmod(dirname(configPath), 0o700);
    }
    catch { /* best-effort */ }
    let handle;
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
        try {
            handle = await open(lockPath, "wx", 0o600);
            break;
        }
        catch (error) {
            if (error?.code !== "EEXIST")
                throw error;
            try {
                const info = await lstat(lockPath);
                if (info.isSymbolicLink())
                    throw new Error(`Invalid OpenCode TUI lock: ${lockPath}`);
                if (Date.now() - info.mtimeMs > LOCK_STALE_MS)
                    await unlink(lockPath);
            }
            catch (lockError) {
                if (lockError instanceof Error && !(lockError.code === "ENOENT"))
                    throw lockError;
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        }
    }
    if (!handle)
        throw new Error(`Could not acquire OpenCode TUI configuration lock: ${configPath}`);
    try {
        return await fn();
    }
    finally {
        try {
            await handle.close();
        }
        catch { /* best-effort */ }
        try {
            await unlink(lockPath);
        }
        catch { /* best-effort */ }
    }
}
export async function ensureTuiRegistered(configPath = globalTuiConfigPath(), entry = TUI_ENTRY) {
    return withConfigLock(configPath, async () => {
        const source = await readConfig(configPath);
        const errors = [];
        const current = source.trim()
            ? parse(source, errors, { allowTrailingComma: true })
            : {};
        if (errors.length > 0 || !current || Array.isArray(current)) {
            throw new Error(`Cannot update invalid OpenCode TUI configuration: ${configPath}`);
        }
        const configured = current.plugin;
        if (configured !== undefined && !Array.isArray(configured)) {
            throw new Error(`OpenCode TUI "plugin" must be an array: ${configPath}`);
        }
        const plugins = (configured ?? []);
        if (plugins.includes(entry) || plugins.includes("opencode-qoder-bridge")) {
            return "present";
        }
        const base = source.trim()
            ? source
            : '{\n  "$schema": "https://opencode.ai/tui.json"\n}\n';
        const eol = base.includes("\r\n") ? "\r\n" : "\n";
        const edits = modify(base, ["plugin"], [...plugins, entry], {
            formattingOptions: {
                insertSpaces: true,
                tabSize: 2,
                eol,
            },
        });
        const updated = applyEdits(base, edits);
        await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
        const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, updated, { encoding: "utf8", mode: 0o600 });
            await rename(temporary, configPath);
        }
        catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
        return "added";
    });
}
//# sourceMappingURL=tui-register.js.map