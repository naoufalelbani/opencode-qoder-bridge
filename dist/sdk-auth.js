import { accessToken, accessTokenFromEnv, qodercliAuth } from "@qoder-ai/qoder-agent-sdk";
import { isAuthenticated } from "./auth.js";
export const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN";
export function hasQoderPAT(environment = process.env) {
    return Boolean(environment[QODER_PAT_ENV]?.trim());
}
/** Prefer a PAT when present, while retaining local qoder login compatibility. */
export function qoderAuth(environment = process.env) {
    const token = environment[QODER_PAT_ENV];
    if (!token?.trim())
        return qodercliAuth();
    // Keep the SDK's env-backed auth shape for normal values, but avoid sending
    // accidental surrounding whitespace when a caller configured a token that
    // was copied from a shell or secret store.
    return token === token.trim() ? accessTokenFromEnv(QODER_PAT_ENV) : accessToken(token.trim());
}
export function hasQoderCredential(environment = process.env) {
    return hasQoderPAT(environment) || isAuthenticated();
}
//# sourceMappingURL=sdk-auth.js.map