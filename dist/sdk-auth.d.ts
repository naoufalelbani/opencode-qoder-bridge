import type { AuthOptions } from "@qoder-ai/qoder-agent-sdk";
export declare const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN";
export declare function hasQoderPAT(environment?: Record<string, string | undefined>): boolean;
/** Prefer a PAT when present, while retaining local qoder login compatibility. */
export declare function qoderAuth(environment?: Record<string, string | undefined>): AuthOptions;
export declare function hasQoderCredential(environment?: Record<string, string | undefined>): boolean;
//# sourceMappingURL=sdk-auth.d.ts.map