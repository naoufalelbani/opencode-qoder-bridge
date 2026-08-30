import { redactSensitiveText } from "./logger.js";
/**
 * Base class for all errors raised by the bridge. Carries a stable `code`
 * so callers and tests can branch on failure mode without parsing messages.
 */
export class QoderBridgeError extends Error {
    code;
    constructor(code, message, options) {
        super(message);
        this.name = new.target.name;
        this.code = code;
        if (options?.cause !== undefined)
            this.cause = options.cause;
    }
}
export class QoderCliNotFoundError extends QoderBridgeError {
    constructor(message = "Qoder CLI runtime not found. Install Qoder CLI or use the bundled Qoder SDK runtime.", options) {
        super("QODER_CLI_NOT_FOUND", message, options);
    }
}
export class QoderAuthError extends QoderBridgeError {
    constructor(message, options) {
        super("QODER_AUTH_FAILED", message, options);
    }
}
export class QoderSessionError extends QoderBridgeError {
    constructor(message, options) {
        super("QODER_SESSION_INVALID_KEY", message, options);
    }
}
export class QoderSdkResultError extends QoderBridgeError {
    subtype;
    constructor(subtype, detail = "", options) {
        const safeSubtype = redactSensitiveText(String(subtype)).slice(0, 256);
        const safeDetail = redactSensitiveText(String(detail)).slice(0, 4096);
        super("QODER_SDK_RESULT_ERROR", `Qoder SDK: ${safeSubtype}${safeDetail ? ` | ${safeDetail}` : ""}`, options);
        this.subtype = safeSubtype;
    }
}
export class UnsupportedCapabilityError extends QoderBridgeError {
    constructor(capability) {
        super("QODER_UNSUPPORTED_CAPABILITY", `Qoder provider does not support ${capability}`);
    }
}
//# sourceMappingURL=errors.js.map