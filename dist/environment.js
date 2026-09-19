const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Merge caller overrides without allowing malformed child-environment keys. */
export function mergedEnvironment(environment = undefined) {
    const merged = { ...process.env };
    if (!environment)
        return withPortablePath(merged);
    for (const [key, value] of Object.entries(environment)) {
        if (!ENV_KEY.test(key))
            continue;
        if (typeof value === "string" || value === undefined)
            merged[key] = value;
    }
    return withPortablePath(merged);
}
function withPortablePath(environment) {
    if (process.platform === "win32" && environment.PATH === undefined && environment.Path !== undefined) {
        environment.PATH = environment.Path;
    }
    return environment;
}
//# sourceMappingURL=environment.js.map