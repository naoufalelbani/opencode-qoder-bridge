import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

const TUI_ENTRY = new URL("./tui.js", import.meta.url).href;
const LOCK_STALE_MS = 120_000;
const LOCK_ATTEMPTS = 80;

function globalTuiConfigPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim();
  const platformHome = process.platform === "win32" ? process.env.APPDATA?.trim() : undefined;
  return join(configHome || platformHome || join(homedir(), ".config"), "opencode", "tui.json");
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function readConfig(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return "";
    throw error;
  }
}

async function withConfigLock<T>(configPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${configPath}.qoder-bridge.lock`;
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  try { await chmod(dirname(configPath), 0o700); } catch { /* best-effort */ }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        const info = await lstat(lockPath);
        if (info.isSymbolicLink()) throw new Error(`Invalid OpenCode TUI lock: ${lockPath}`);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(lockPath);
      } catch (lockError) {
        if (lockError instanceof Error && !((lockError as NodeJS.ErrnoException).code === "ENOENT")) throw lockError;
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  if (!handle) throw new Error(`Could not acquire OpenCode TUI configuration lock: ${configPath}`);

  try {
    return await fn();
  } finally {
    try { await handle.close(); } catch { /* best-effort */ }
    try { await unlink(lockPath); } catch { /* best-effort */ }
  }
}

export async function ensureTuiRegistered(
  configPath = globalTuiConfigPath(),
  entry = TUI_ENTRY,
): Promise<"added" | "present"> {
  return withConfigLock(configPath, async () => {
    const source = await readConfig(configPath);
    const errors: ParseError[] = [];
    const current = source.trim()
      ? (parse(source, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined)
      : {};

    if (errors.length > 0 || !current || Array.isArray(current)) {
      throw new Error(`Cannot update invalid OpenCode TUI configuration: ${configPath}`);
    }

    const configured = current.plugin;
    if (configured !== undefined && !Array.isArray(configured)) {
      throw new Error(`OpenCode TUI "plugin" must be an array: ${configPath}`);
    }

    const plugins = (configured ?? []) as unknown[];
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
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }

    return "added";
  });
}
