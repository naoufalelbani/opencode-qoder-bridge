/** Race SDK operations against a host-side deadline. Aborting the SDK is
 * still the caller's responsibility; this helper guarantees the bridge does
 * not wait forever for a non-cooperative promise. */
export declare function withTimeout<T>(operation: PromiseLike<T>, timeoutMs: number, message: string): Promise<T>;
export declare function closeAsyncIterator(iterator: {
    return?: (value?: void | PromiseLike<void>) => PromiseLike<unknown> | unknown;
}, timeoutMs: number): Promise<void>;
//# sourceMappingURL=async-utils.d.ts.map