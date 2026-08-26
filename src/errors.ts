export type QoderBridgeErrorCode =
  | "QODER_CLI_NOT_FOUND"
  | "QODER_AUTH_FAILED"
  | "QODER_SESSION_INVALID_KEY"
  | "QODER_SDK_RESULT_ERROR"
  | "QODER_UNSUPPORTED_CAPABILITY";

/**
 * Base class for all errors raised by the bridge. Carries a stable `code`
 * so callers and tests can branch on failure mode without parsing messages.
 */
export class QoderBridgeError extends Error {
  readonly code: QoderBridgeErrorCode;

  constructor(code: QoderBridgeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export class QoderCliNotFoundError extends QoderBridgeError {
  constructor(message = "Qoder CLI runtime not found. Install Qoder CLI or use the bundled Qoder SDK runtime.", options?: { cause?: unknown }) {
    super("QODER_CLI_NOT_FOUND", message, options);
  }
}

export class QoderAuthError extends QoderBridgeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("QODER_AUTH_FAILED", message, options);
  }
}

export class QoderSessionError extends QoderBridgeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("QODER_SESSION_INVALID_KEY", message, options);
  }
}

export class QoderSdkResultError extends QoderBridgeError {
  readonly subtype: string;

  constructor(subtype: string, detail = "", options?: { cause?: unknown }) {
    super("QODER_SDK_RESULT_ERROR", `Qoder SDK: ${subtype}${detail ? ` | ${detail}` : ""}`, options);
    this.subtype = subtype;
  }
}

export class UnsupportedCapabilityError extends QoderBridgeError {
  constructor(capability: string) {
    super("QODER_UNSUPPORTED_CAPABILITY", `Qoder provider does not support ${capability}`);
  }
}
