export interface QoderSessionRecord {
    qoderSessionId: string;
    cwd: string;
    createdAt: string;
    lastUsedAt: string;
}
/**
 * Serialize a persisted/explicit Qoder session across both threads and OS
 * processes. The lease covers the SDK turn, not just the JSON mapping write.
 */
export declare function withQoderSessionLease<T>(key: string, cwd: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T | undefined>;
/** Read the generation used to fence reset-all against in-flight writes. */
export declare function getQoderSessionResetEpoch(): Promise<string>;
export declare function getQoderSession(key: string, cwd?: string): Promise<QoderSessionRecord | null>;
export declare function getQoderSessionForCwd(key: string, cwd: string): Promise<QoderSessionRecord | null>;
export declare function ensureQoderSession(key: string, qoderSessionId: string, cwd: string, expectedResetEpoch?: string): Promise<QoderSessionRecord>;
export declare function deleteQoderSession(key: string, cwd?: string): Promise<void>;
/** Delete a mapping after waiting for any active turn in the same workspace. */
export declare function deleteQoderSessionForCwd(key: string, cwd: string, leaseKey?: string): Promise<void>;
export declare function clearAllSessions(): Promise<void>;
//# sourceMappingURL=session-store.d.ts.map