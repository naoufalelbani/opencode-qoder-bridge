type RuntimeSdk = typeof import("@qoder-ai/qoder-agent-sdk");
export declare function isCnRuntime(environment?: Record<string, string | undefined>): boolean;
/** Load the official SDK build for the account's Qoder region. */
export declare function getSdkRuntime(environment?: Record<string, string | undefined>): Promise<RuntimeSdk>;
export {};
//# sourceMappingURL=sdk-runtime.d.ts.map