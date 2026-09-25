import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, delimiter } from "node:path";
import { debug } from "./logger.js";

export type QoderRegion = "global" | "cn";
export type QoderRegionPreference = "auto" | QoderRegion;

export const QODER_REGION_ENV = "QODER_REGION";
export const QODER_CLI_PATH_ENV = "QODER_CLI_PATH";

function authFiles(): string[] {
  const home = homedir();
  return [
    join(home, ".qoderwork", ".auth", "user"),
    join(home, ".qoder", ".auth", "user"),
    // Qoder CN region uses a separate home (qoderclicn).
    join(home, ".qoder-cn", ".auth", "user"),
  ];
}

export function isAuthenticated(): boolean {
  return authFiles().some((p) => isRegularFile(p));
}

/** Classify a resolved CLI path by region. Null when no CLI is resolved. */
export function getQoderRegion(cliPath?: string | null): QoderRegion | null {
  const resolved = cliPath ?? findQoderCLI();
  if (!resolved) return null;
  return basename(resolved).startsWith("qoderclicn") || resolved.includes(".qoder-cn") ? "cn" : "global";
}

/** Read the QODER_REGION preference (`auto` default). */
export function regionPreference(
  environment: Record<string, string | undefined> = process.env,
): QoderRegionPreference {
  const raw = environment[QODER_REGION_ENV]?.trim().toLowerCase();
  return raw === "cn" || raw === "global" ? raw : "auto";
}

/** Region-aware login hint for auth errors. */
export function cliLoginHint(
  environment: Record<string, string | undefined> = process.env,
): string {
  return regionPreference(environment) === "cn"
    ? "Run the CN CLI login or set QODER_PERSONAL_ACCESS_TOKEN."
    : "Run `qoder login` (CN region: the CN CLI login) or set QODER_PERSONAL_ACCESS_TOKEN.";
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

function describeSearchLocations(): Array<{ base: string; exe: string; bin: string; prefix: string }> {
  const home = homedir();
  const suffix = process.platform === "win32" ? ".exe" : "";
  return [
    { base: join(home, ".qoder"), exe: `qodercli${suffix}`, bin: "qodercli", prefix: "qodercli-" },
    { base: join(home, ".qoder-cn"), exe: `qoderclicn${suffix}`, bin: "qoderclicn", prefix: "qoderclicn-" },
  ];
}

/**
 * Resolve the qodercli binary (global and CN region). Search order:
 *  1. QODER_CLI_PATH override (must be executable, else fall through)
 *  2. PATH (qodercli, then qoderclicn per directory)
 *  3. ~/.qoder/local and ~/.qoder-cn/local (global location first)
 *  4. ~/.qoder/bin/qodercli and ~/.qoder-cn/bin/qoderclicn (latest
 *     versioned binary; global wins version ties)
 * QODER_REGION=global|cn restricts discovery to one region (default auto).
 * Returns null when no separately installed CLI is found. The Qoder SDK can
 * still run through its bundled Worker runtime when credentials are present.
 */
export function findQoderCLI(force = false): string | null {
  if (!force && cachedCliPath !== undefined) return cachedCliPath;
  cachedCliPath = resolveCli(process.env);
  debug(`Qoder CLI resolved: ${cachedCliPath ?? "none"} (region: ${getQoderRegion(cachedCliPath) ?? "none"})`);
  return cachedCliPath;
}

export function resetCachedCliPath(): void {
  cachedCliPath = undefined;
}

function resolveCli(environment: Record<string, string | undefined>): string | null {
  const preference = regionPreference(environment);
  const locations = describeSearchLocations().filter(
    (location) => preference === "auto" || regionOfBase(location.base) === preference,
  );
  const exeNames = locations.map((location) => location.exe);

  const override = environment[QODER_CLI_PATH_ENV]?.trim();
  if (override) {
    if (isAbsolute(override) && isExecutableFile(override)) return override;
    debug(`Qoder CLI override ${QODER_CLI_PATH_ENV} is not an executable file; falling back to discovery.`);
  }

  for (const dir of (environment.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const exe of exeNames) {
      const p = join(dir, exe);
      if (isExecutableFile(p)) return p;
    }
  }

  for (const location of locations) {
    // Tolerate either binary name in either home for renamed installs.
    for (const exe of exeNames) {
      const local = join(location.base, "local", exe);
      if (isExecutableFile(local)) return local;
    }
  }

  type Candidate = { path: string; file: string; region: QoderRegion };
  const candidates: Candidate[] = [];
  const prefixes = locations.map((location) => location.prefix);
  for (const location of locations) {
    const binDir = join(location.base, "bin", location.bin);
    try {
      for (const file of readdirSync(binDir)) {
        // Accept either versioned prefix in either directory.
        if (!prefixes.some((prefix) => file.startsWith(prefix))) continue;
        candidates.push({
          path: join(binDir, file),
          file,
          region: regionOfBase(location.base) === "cn" || file.startsWith("qoderclicn-") ? "cn" : "global",
        });
      }
    } catch {
      /* not installed */
    }
  }
  candidates.sort((a, b) => {
    if (stripCliPrefix(a.file) === stripCliPrefix(b.file)) {
      // Global wins version ties so both regions share one policy.
      return regionOrder(a.region) - regionOrder(b.region);
    }
    return compareCliVersions(b.file, a.file);
  });
  for (const candidate of candidates) {
    if (isExecutableFile(candidate.path)) return candidate.path;
  }

  return null;
}

function regionOfBase(base: string): QoderRegion {
  return base.includes(".qoder-cn") ? "cn" : "global";
}

function regionOrder(region: QoderRegion): number {
  return region === "global" ? 0 : 1;
}

function stripCliPrefix(name: string): string {
  for (const prefix of ["qoderclicn-", "qodercli-"]) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

function compareCliVersions(left: string, right: string): number {
  const leftParts = stripCliPrefix(left).split(/[.-]/);
  const rightParts = stripCliPrefix(right).split(/[.-]/);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i++) {
    const a = leftParts[i] ?? "";
    const b = rightParts[i] ?? "";
    const aNumber = /^\d+$/.test(a) ? Number(a) : NaN;
    const bNumber = /^\d+$/.test(b) ? Number(b) : NaN;
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber) && aNumber !== bNumber) return aNumber - bNumber;
    if (a !== b) return a.localeCompare(b);
  }
  return left.localeCompare(right);
}
