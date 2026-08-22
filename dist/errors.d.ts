export type QoderBridgeErrorCode = "QODER_CLI_NOT_FOUND" | "QODER_AUTH_FAILED" | "QODER_SESSION_INVALID_KEY" | "QODER_SDK_RESULT_ERROR" | "QODER_UNSUPPORTED_CAPABILITY";
/**
 * Base class for all errors raised by the bridge. Carries a stable `code`
 * so callers and tests can branch on failure mode without parsing messages.
 */
export declare class QoderBridgeError extends Error {
    readonly code: QoderBridgeErrorCode;
    constructor(code: QoderBridgeErrorCode, message: string, options?: {
        cause?: unknown;
    });
}
export declare class QoderCliNotFoundError extends QoderBridgeError {
    constructor(message?: string, options?: {
        cause?: unknown;
    });
}
export declare class QoderAuthError extends QoderBridgeError {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare class QoderSessionError extends QoderBridgeError {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare class QoderSdkResultError extends QoderBridgeError {
    readonly subtype: string;
    constructor(subtype: string, detail?: string, options?: {
        cause?: unknown;
    });
}
export declare class UnsupportedCapabilityError extends QoderBridgeError {
    constructor(capability: string);
}
//# sourceMappingURL=errors.d.ts.map