/** Race SDK operations against a host-side deadline. Aborting the SDK is
 * still the caller's responsibility; this helper guarantees the bridge does
 * not wait forever for a non-cooperative promise. */
export function withTimeout(operation, timeoutMs, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        if (typeof timer.unref === "function")
            timer.unref();
    });
    return Promise.race([Promise.resolve(operation), timeout]).finally(() => {
        if (timer)
            clearTimeout(timer);
    });
}
export async function closeAsyncIterator(iterator, timeoutMs) {
    if (typeof iterator.return !== "function")
        return;
    const closing = Promise.resolve().then(() => iterator.return?.(undefined)).then(() => undefined);
    try {
        await withTimeout(closing, timeoutMs, "SDK iterator cleanup timed out");
    }
    catch {
        // Cleanup is best effort; the request's primary error remains authoritative.
    }
}
//# sourceMappingURL=async-utils.js.map