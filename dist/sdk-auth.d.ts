import type { Options } from "@qoder-ai/qoder-agent-sdk";
export declare const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN";
export declare const QODER_AUTH_MODE_ENV = "QODER_AUTH_MODE";
export interface BrowserCredential {
    type: "oauth";
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
}
export interface BrowserAuthSource {
    accountId?: string;
    storeBacked?: boolean;
    read: () => Promise<BrowserCredential | null>;
    write: (credential: BrowserCredential, previous: BrowserCredential) => Promise<void>;
}
/** OpenCode owns the saved OAuth credential; the bridge only holds accessors. */
export declare function configureBrowserAuth(source: BrowserAuthSource | null): void;
export declare function browserAuthIdentity(environment?: Record<string, string | undefined>): string | undefined;
export declare function hasQoderPAT(environment?: Record<string, string | undefined>): boolean;
/** PAT, CLI login, and browser sign-in all drive the same SDK runtime. */
export declare function qoderAuth(environment?: Record<string, string | undefined>): Options["auth"];
export declare function hasQoderCredential(environment?: Record<string, string | undefined>): boolean;
//# sourceMappingURL=sdk-auth.d.ts.map