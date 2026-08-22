const PREFIX = "[opencode-qoder-bridge]";
const TRUTHY = /^(1|true|yes|on)$/i;

/** Debug output is opt-in via QODER_BRIDGE_DEBUG=1. */
export function isDebugEnabled(): boolean {
  return TRUTHY.test(process.env.QODER_BRIDGE_DEBUG?.trim() ?? "");
}

export function debug(message: string, ...details: unknown[]): void {
  if (!isDebugEnabled()) return;
  console.info(`${PREFIX} ${message}`, ...details);
}

export function warn(message: string, ...details: unknown[]): void {
  console.warn(`${PREFIX} ${message}`, ...details);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
