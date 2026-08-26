import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";

const AUTH_FILES = [
  join(homedir(), ".qoderwork", ".auth", "user"),
  join(homedir(), ".qoder", ".auth", "user"),
];

export function isAuthenticated(): boolean {
  return AUTH_FILES.some((p) => isRegularFile(p));
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(p: string): boolean {
  if (!isRegularFile(p)) return false;
  if (process.platform === "win32") return true;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let cachedCliPath: string | null | undefined;

/**
 * Resolve the qodercli binary. Search order:
 *  1. PATH
 *  2. ~/.qoder/local/qodercli
 *  3. ~/.qoder/bin/qodercli/qodercli-<version> (latest)
 * Returns null when no separately installed CLI is found. The Qoder SDK can
 * still run through its bundled Worker runtime when credentials are present.
 */
export function findQoderCLI(): string | null {
  if (cachedCliPath !== undefined) return cachedCliPath;
  cachedCliPath = resolveCli();
  return cachedCliPath;
}

function resolveCli(): string | null {
  const exe = process.platform === "win32" ? "qodercli.exe" : "qodercli";

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, exe);
    if (isExecutableFile(p)) return p;
  }

  const local = join(homedir(), ".qoder", "local", exe);
  if (isExecutableFile(local)) return local;

  const binDir = join(homedir(), ".qoder", "bin", "qodercli");
  try {
    const latest = readdirSync(binDir)
      .filter((f) => f.startsWith("qodercli-"))
      .sort()
      .at(-1);
    if (latest) {
      const p = join(binDir, latest);
      if (isExecutableFile(p)) return p;
    }
  } catch {
    /* not installed */
  }

  return null;
}
