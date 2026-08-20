export interface QoderSessionRecord {
    qoderSessionId: string;
    cwd: string;
    createdAt: string;
    lastUsedAt: string;
}
export declare function getQoderSession(key: string): Promise<QoderSessionRecord | null>;
export declare function ensureQoderSession(key: string, qoderSessionId: string, cwd: string): Promise<QoderSessionRecord>;
export declare function deleteQoderSession(key: string): Promise<void>;
//# sourceMappingURL=session-store.d.ts.map