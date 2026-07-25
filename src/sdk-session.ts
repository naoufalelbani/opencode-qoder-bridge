import type { SDKUserMessage } from "@qoder-ai/qoder-agent-sdk";

export async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage, void> {
  if (!signal.aborted) {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}
