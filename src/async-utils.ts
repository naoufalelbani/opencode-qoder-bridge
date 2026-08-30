/** Race SDK operations against a host-side deadline. Aborting the SDK is
 * still the caller's responsibility; this helper guarantees the bridge does
 * not wait forever for a non-cooperative promise. */
export function withTimeout<T>(operation: PromiseLike<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([Promise.resolve(operation), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function closeAsyncIterator(
  iterator: { return?: (value?: void | PromiseLike<void>) => PromiseLike<unknown> | unknown },
  timeoutMs: number,
): Promise<void> {
  if (typeof iterator.return !== "function") return;
  const closing = Promise.resolve().then(() => iterator.return?.(undefined)).then(() => undefined);
  try {
    await withTimeout(closing, timeoutMs, "SDK iterator cleanup timed out");
  } catch {
    // Cleanup is best effort; the request's primary error remains authoritative.
  }
}
