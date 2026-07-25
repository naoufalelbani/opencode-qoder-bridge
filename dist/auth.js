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
 * Returns null when nothing is found.
 */
export function findQoderCLI() {
    if (cachedCliPath !== undefined)
        return cachedCliPath;
    cachedCliPath = resolveCli();
    return cachedCliPath;
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
        const latest = readdirSync(binDir)
            .filter((f) => f.startsWith("qodercli-"))
            .sort()
            .at(-1);
        if (latest) {
            const p = join(binDir, latest);
            if (isExecutableFile(p))
                return p;
        }
    }
    catch {
        /* not installed */
    }
    return null;
}
//# sourceMappingURL=auth.js.map