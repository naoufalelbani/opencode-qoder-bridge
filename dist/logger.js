const PREFIX = "[opencode-qoder-bridge]";
const TRUTHY = /^(1|true|yes|on)$/i;
const MAX_ERROR_TEXT = 4096;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const SENSITIVE_VALUE = /((?:"?)(?:authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|password|secret|credential|token)(?:"?)\s*[:=]\s*)(Bearer\s+[^\s,;}]+|"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/gi;
const QUERY_SECRET = /([?&](?:access_token|refresh_token|token|api_key|apikey|secret|password)=)[^&#\s]+/gi;
const TOKEN_PREFIX = /\b(?:pt|qoder)[_-][A-Za-z0-9._~-]{8,}/gi;
/** Debug output is opt-in via QODER_BRIDGE_DEBUG=1. */
export function isDebugEnabled() {
    return TRUTHY.test(process.env.QODER_BRIDGE_DEBUG?.trim() ?? "");
}
export function debug(message, ...details) {
    if (!isDebugEnabled())
        return;
    console.info(`${PREFIX} ${redactSensitiveText(message)}`, ...details.map(safeLogDetail));
}
export function warn(message, ...details) {
    console.warn(`${PREFIX} ${redactSensitiveText(message)}`, ...details.map(safeLogDetail));
}
export function redactSensitiveText(value) {
    let redacted = value;
    for (const secret of [process.env.QODER_PERSONAL_ACCESS_TOKEN, process.env.QODER_API_KEY]) {
        if (secret && secret.length >= 4)
            redacted = redacted.split(secret).join("[REDACTED]");
    }
    return redacted
        .replace(BEARER_VALUE, "Bearer [REDACTED]")
        .replace(SENSITIVE_VALUE, "$1[REDACTED]")
        .replace(QUERY_SECRET, "$1[REDACTED]")
        .replace(TOKEN_PREFIX, "[REDACTED]")
        .replace(CONTROL_CHARS, " ");
}
function safeLogDetail(detail) {
    if (detail instanceof Error)
        return describeError(detail);
    if (typeof detail === "string")
        return redactSensitiveText(detail).slice(0, MAX_ERROR_TEXT);
    try {
        return redactSensitiveText(JSON.stringify(detail)).slice(0, MAX_ERROR_TEXT);
    }
    catch {
        return "[unserializable log detail]";
    }
}
export function describeError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return redactSensitiveText(message).slice(0, MAX_ERROR_TEXT);
}
//# sourceMappingURL=logger.js.map