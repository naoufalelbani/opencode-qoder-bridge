const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function stringRecord(v) {
    if (!isRecord(v))
        return undefined;
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        if (!UNSAFE_KEYS.has(k) && typeof val === "string")
            out[k] = val;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
function stringArray(v) {
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
}
/**
 * Convert a single opencode `config.mcp[name]` entry into an SDK McpServerConfig.
 * Returns null when the entry is disabled or unrecognized.
 */
function convertEntry(raw) {
    if (!isRecord(raw) || raw.enabled === false)
        return null;
    // In-process SDK server instances pass through untouched.
    if (raw.type === "sdk" && typeof raw.name === "string" && raw.instance != null) {
        return { type: "sdk", name: raw.name, instance: raw.instance };
    }
    // stdio: command as array
    const cmdArr = stringArray(raw.command);
    if (cmdArr && cmdArr.length > 0) {
        const [command, ...args] = cmdArr;
        const env = stringRecord(raw.environment) ?? stringRecord(raw.env);
        return {
            type: "stdio",
            command,
            ...(args.length > 0 ? { args } : {}),
            ...(env ? { env } : {}),
        };
    }
    // stdio: command as string
    if (typeof raw.command === "string") {
        const args = stringArray(raw.args);
        const env = stringRecord(raw.environment) ?? stringRecord(raw.env);
        return {
            type: "stdio",
            command: raw.command,
            ...(args && args.length > 0 ? { args } : {}),
            ...(env ? { env } : {}),
        };
    }
    // remote: http / sse
    const url = typeof raw.url === "string" ? raw.url : undefined;
    if (url) {
        const headers = stringRecord(raw.headers);
        return {
            type: raw.type === "sse" ? "sse" : "http",
            url,
            ...(headers ? { headers } : {}),
        };
    }
    return null;
}
/**
 * Bridge opencode `config.mcp` into SDK `mcpServers`.
 * Disabled and unrecognized entries are dropped.
 */
export function bridgeMcpServers(mcp) {
    if (!isRecord(mcp))
        return {};
    const out = {};
    for (const [name, raw] of Object.entries(mcp)) {
        if (UNSAFE_KEYS.has(name))
            continue;
        const cfg = convertEntry(raw);
        if (cfg)
            out[name] = cfg;
    }
    return out;
}
//# sourceMappingURL=mcp-bridge.js.map