import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

const TUI_ENTRY = new URL("./tui.js", import.meta.url).href;

function globalTuiConfigPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim();
  return join(configHome || join(homedir(), ".config"), "opencode", "tui.json");
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

export async function ensureTuiRegistered(
  configPath = globalTuiConfigPath(),
  entry = TUI_ENTRY,
): Promise<"added" | "present"> {
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
}
