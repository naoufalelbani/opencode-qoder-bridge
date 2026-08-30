const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_MCP_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_MCP_TIMEOUT_MS = 1_000;
const MAX_MCP_STRING_LENGTH = 16_384;
const MAX_MCP_SERVERS = 256;
const MAX_MCP_ENTRIES = 512;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function stringRecord(v) {
    if (!isRecord(v))
        return undefined;
    if (Object.keys(v).length > MAX_MCP_ENTRIES)
        return undefined;
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        if (!UNSAFE_KEYS.has(k)
            && k.length <= 256
            && !CONTROL_CHARS.test(k)
            && typeof val === "string"
            && val.length <= MAX_MCP_STRING_LENGTH
            && !CONTROL_CHARS.test(val))
            out[k] = val;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
function stringArray(v) {
    if (!Array.isArray(v) || v.length === 0)
        return undefined;
    if (v.length > MAX_MCP_ENTRIES)
        return undefined;
    const out = [];
    for (const item of v) {
        if (typeof item === "string" && item.length <= MAX_MCP_STRING_LENGTH && !CONTROL_CHARS.test(item))
            out.push(item);
        else if (typeof item === "number" || typeof item === "boolean")
            out.push(String(item));
        else
            return undefined;
    }
    return out.length > 0 ? out : undefined;
}
function timeoutValue(v) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
        return undefined;
    const normalized = Math.floor(v);
    return normalized >= MIN_MCP_TIMEOUT_MS ? Math.min(MAX_MCP_TIMEOUT_MS, normalized) : MIN_MCP_TIMEOUT_MS;
}
function httpUrl(v) {
    if (typeof v !== "string" || v.length > MAX_MCP_STRING_LENGTH || CONTROL_CHARS.test(v))
        return undefined;
    try {
        const parsed = new URL(v);
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
            && parsed.hostname
            && !parsed.username
            && !parsed.password
            ? v
            : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Convert a single opencode `config.mcp[name]` entry into an SDK McpServerConfig.
 * Returns null when the entry is disabled or unrecognized.
 */
function convertEntry(raw) {
    if (!isRecord(raw) || raw.enabled === false)
        return null;
    if (raw.type !== undefined && raw.type !== "sdk" && raw.type !== "stdio" && raw.type !== "sse" && raw.type !== "http")
        return null;
    const timeout = timeoutValue(raw.timeout);
    // In-process SDK server instances pass through untouched.
    if (raw.type === "sdk" && typeof raw.name === "string" && raw.instance != null) {
        return { type: "sdk", name: raw.name, instance: raw.instance };
    }
    // stdio: command as array
    const cmdArr = stringArray(raw.command);
    if (cmdArr && cmdArr.length > 0 && cmdArr[0].trim()) {
        const [command, ...args] = cmdArr;
        const env = stringRecord(raw.environment) ?? stringRecord(raw.env);
        return {
            type: "stdio",
            command,
            ...(args.length > 0 ? { args } : {}),
            ...(env ? { env } : {}),
            ...(timeout !== undefined ? { timeout } : {}),
        };
    }
    // stdio: command as string
    if (typeof raw.command === "string"
        && raw.command.length <= MAX_MCP_STRING_LENGTH
        && !CONTROL_CHARS.test(raw.command)
        && raw.command.trim()) {
        if (Array.isArray(raw.args) && !stringArray(raw.args))
            return null;
        const args = stringArray(raw.args);
        const env = stringRecord(raw.environment) ?? stringRecord(raw.env);
        return {
            type: "stdio",
            command: raw.command,
            ...(args && args.length > 0 ? { args } : {}),
            ...(env ? { env } : {}),
            ...(timeout !== undefined ? { timeout } : {}),
        };
    }
    // remote: http / sse
    const url = httpUrl(raw.url);
    if (url) {
        const headers = stringRecord(raw.headers);
        return {
            type: raw.type === "sse" ? "sse" : "http",
            url,
            ...(headers ? { headers } : {}),
            ...(timeout !== undefined ? { timeout } : {}),
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
    let count = 0;
    for (const [name, raw] of Object.entries(mcp)) {
        if (count >= MAX_MCP_SERVERS)
            break;
        if (UNSAFE_KEYS.has(name) || name.length === 0 || name.length > 256 || CONTROL_CHARS.test(name))
            continue;
        const cfg = convertEntry(raw);
        if (cfg) {
            out[name] = cfg;
            count++;
        }
    }
    return out;
}
//# sourceMappingURL=mcp-bridge.js.map