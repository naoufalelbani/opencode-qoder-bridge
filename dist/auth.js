import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
const AUTH_FILES = [
    join(homedir(), ".qoderwork", ".auth", "user"),
    join(homedir(), ".qoder", ".auth", "user"),
];
export function isAuthenticated() {
    return AUTH_FILES.some((p) => isRegularFile(p));
}
function isRegularFile(p) {
    try {
        return statSync(p).isFile();
    }
    catch {
        return false;
    }
}
function isExecutableFile(p) {
    if (!isRegularFile(p))
        return false;
    if (process.platform === "win32")
        return true;
    try {
        accessSync(p, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
let cachedCliPath;
/**
 * Resolve the qodercli binary. Search order:
 *  1. PATH
 *  2. ~/.qoder/local/qodercli
 *  3. ~/.qoder/bin/qodercli/qodercli-<version> (latest)
 * Returns null when no separately installed CLI is found. The Qoder SDK can
 * still run through its bundled Worker runtime when credentials are present.
 */
export function findQoderCLI(force = false) {
    if (!force && cachedCliPath !== undefined)
        return cachedCliPath;
    cachedCliPath = resolveCli();
    return cachedCliPath;
}
export function resetCachedCliPath() {
    cachedCliPath = undefined;
}
function resolveCli() {
    const exe = process.platform === "win32" ? "qodercli.exe" : "qodercli";
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        if (!dir)
            continue;
        const p = join(dir, exe);
        if (isExecutableFile(p))
            return p;
    }
    const local = join(homedir(), ".qoder", "local", exe);
    if (isExecutableFile(local))
        return local;
    const binDir = join(homedir(), ".qoder", "bin", "qodercli");
    try {
        const versions = readdirSync(binDir)
            .filter((f) => f.startsWith("qodercli-"))
            .sort(compareCliVersions)
            .reverse();
        for (const version of versions) {
            const p = join(binDir, version);
            if (isExecutableFile(p))
                return p;
        }
    }
    catch {
        /* not installed */
    }
    return null;
}
function compareCliVersions(left, right) {
    const leftParts = left.slice("qodercli-".length).split(/[.-]/);
    const rightParts = right.slice("qodercli-".length).split(/[.-]/);
    const length = Math.max(leftParts.length, rightParts.length);
    for (let i = 0; i < length; i++) {
        const a = leftParts[i] ?? "";
        const b = rightParts[i] ?? "";
        const aNumber = /^\d+$/.test(a) ? Number(a) : NaN;
        const bNumber = /^\d+$/.test(b) ? Number(b) : NaN;
        if (Number.isFinite(aNumber) && Number.isFinite(bNumber) && aNumber !== bNumber)
            return aNumber - bNumber;
        if (a !== b)
            return a.localeCompare(b);
    }
    return left.localeCompare(right);
}
//# sourceMappingURL=auth.js.map