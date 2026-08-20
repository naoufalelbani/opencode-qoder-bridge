import type { AuthOptions } from "@qoder-ai/qoder-agent-sdk";
export declare const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN";
export declare function hasQoderPAT(): boolean;
/** Prefer a PAT when present, while retaining local qoder login compatibility. */
export declare function qoderAuth(): AuthOptions;
export declare function hasQoderCredential(): boolean;
//# sourceMappingURL=sdk-auth.d.ts.map