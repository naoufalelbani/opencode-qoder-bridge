import type { BrowserCredential } from "./sdk-auth.js";
/** Read only Qoder's OAuth entry; other OpenCode credentials are not exposed. */
export declare function readStoredBrowserCredential(environment?: NodeJS.ProcessEnv): BrowserCredential | null;
/** Update Qoder's rotated token pair, retaining the rest of OpenCode's auth file. */
export declare function writeStoredBrowserCredential(updated: BrowserCredential, previous: BrowserCredential, environment?: NodeJS.ProcessEnv): Promise<void>;
//# sourceMappingURL=opencode-auth-store.d.ts.map