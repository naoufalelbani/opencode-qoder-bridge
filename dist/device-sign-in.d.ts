import type { AuthOAuthResult } from "@opencode-ai/plugin";
export interface DeviceSignInDependencies {
    fetch?: typeof fetch;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
}
/** Qoder desktop's browser device flow. The resulting job token is consumed by the SDK. */
export declare function qoderDeviceSignIn(dependencies?: DeviceSignInDependencies): Promise<AuthOAuthResult>;
export declare function refreshQoderJobToken(refreshToken: string, signal: AbortSignal, fetcher?: typeof fetch, now?: () => number): Promise<{
    access: string;
    refresh: string;
    expires: number;
}>;
//# sourceMappingURL=device-sign-in.d.ts.map