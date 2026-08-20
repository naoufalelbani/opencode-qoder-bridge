import { accessTokenFromEnv, qodercliAuth } from "@qoder-ai/qoder-agent-sdk";
import type { AuthOptions } from "@qoder-ai/qoder-agent-sdk";
import { isAuthenticated } from "./auth.js";

export const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN";

export function hasQoderPAT(): boolean {
  return Boolean(process.env[QODER_PAT_ENV]);
}

/** Prefer a PAT when present, while retaining local qoder login compatibility. */
export function qoderAuth(): AuthOptions {
  return hasQoderPAT()
    ? accessTokenFromEnv(QODER_PAT_ENV)
    : qodercliAuth();
}

export function hasQoderCredential(): boolean {
  return hasQoderPAT() || isAuthenticated();
}
