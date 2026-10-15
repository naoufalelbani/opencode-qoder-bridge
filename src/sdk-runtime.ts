import { findQoderCLI, getQoderRegion, isAuthenticated, regionPreference } from "./auth.js";
import { browserAuthRegion, browserAuthVpcEndpoint, hasQoderPAT } from "./sdk-auth.js";

type RuntimeSdk = typeof import("@qoder-ai/qoder-agent-sdk");

let globalSdk: Promise<RuntimeSdk> | undefined;
let cnSdk: Promise<typeof import("@qodercn-ai/qodercn-agent-sdk")> | undefined;

export function isCnRuntime(environment: Record<string, string | undefined> = process.env): boolean {
  const mode = environment.QODER_AUTH_MODE?.trim().toLowerCase();
  const requestedRegion = environment.QODER_REGION?.trim().toLowerCase();
  if (mode !== "cli" && browserAuthVpcEndpoint() && requestedRegion !== "global") return true;
  if (environment.QODER_AUTH_MODE?.trim().toLowerCase() === "browser") {
    const browserRegion = browserAuthRegion();
    if (browserRegion) return browserRegion === "cn";
  }
  const preference = regionPreference(environment);
  if (preference === "cn") return true;
  if (preference === "global" || hasQoderPAT(environment)) return false;
  const cli = findQoderCLI(false, environment);
  if (cli) return getQoderRegion(cli) === "cn";
  if (!isAuthenticated()) return browserAuthRegion() === "cn";
  return false;
}

/** Load the official SDK build for the account's Qoder region. */
export async function getSdkRuntime(environment: Record<string, string | undefined> = process.env): Promise<RuntimeSdk> {
  if (isCnRuntime(environment)) {
    cnSdk ??= import("@qodercn-ai/qodercn-agent-sdk");
    return await cnSdk as unknown as RuntimeSdk;
  }
  globalSdk ??= import("@qoder-ai/qoder-agent-sdk");
  return await globalSdk;
}
