const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Merge caller overrides without allowing malformed child-environment keys. */
export function mergedEnvironment(
  environment: Record<string, string | undefined> | undefined = undefined,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env };
  if (!environment) return withPortablePath(merged);

  for (const [key, value] of Object.entries(environment)) {
    if (!ENV_KEY.test(key)) continue;
    if (typeof value === "string" || value === undefined) merged[key] = value;
  }
  return withPortablePath(merged);
}

function withPortablePath(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  if (process.platform === "win32" && environment.PATH === undefined && environment.Path !== undefined) {
    environment.PATH = environment.Path;
  }
  return environment;
}
