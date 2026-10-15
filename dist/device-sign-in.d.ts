import type { AuthOAuthResult } from "@opencode-ai/plugin";
export type BrowserTokenKind = "job" | "device";
export declare function encodeRefreshToken(region: "global" | "cn", kind: BrowserTokenKind, token: string, vpcEndpoint?: string): string;
export declare function decodeRefreshToken(token: string): {
    region: "global" | "cn";
    kind: BrowserTokenKind;
    token: string;
    vpcEndpoint?: string;
};
export interface DeviceSignInDependencies {
    fetch?: typeof fetch;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
}
/** Qoder desktop's browser device flow. The resulting job token is consumed by the SDK. */
export declare function qoderDeviceSignIn(dependencies?: DeviceSignInDependencies, region?: "global" | "cn", vpcEndpoint?: string): Promise<AuthOAuthResult>;
export declare function refreshQoderJobToken(refreshToken: string, signal: AbortSignal, fetcher?: typeof fetch, now?: () => number, requestedRegion?: "global" | "cn"): Promise<{
    access: string;
    refresh: string;
    expires: number;
}>;
export declare function refreshQoderDeviceToken(refreshToken: string, signal: AbortSignal, fetcher?: typeof fetch, now?: () => number): Promise<{
    access: string;
    refresh: string;
    expires: number;
}>;
export declare function refreshQoderBrowserToken(refreshToken: string, signal: AbortSignal, fetcher?: typeof fetch, now?: () => number): Promise<{
    access: string;
    refresh: string;
    expires: number;
}>;
//# sourceMappingURL=device-sign-in.d.ts.map