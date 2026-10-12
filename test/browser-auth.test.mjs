import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const device = await import("../dist/device-sign-in.js");
const sdkAuth = await import("../dist/sdk-auth.js");

afterEach(() => sdkAuth.configureBrowserAuth(null));

test("browser sign-in exchanges a PKCE device authorization for an SDK job token", async () => {
  const calls = [];
  let polls = 0;
  const fetcher = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname.endsWith("/deviceToken/poll")) {
      polls += 1;
      return Response.json(polls === 1 ? {} : { token: "device-token" }, { status: polls === 1 ? 202 : 200 });
    }
    if (url.pathname.endsWith("/me/jobToken")) {
      assert.equal(init.headers.Authorization, "Bearer device-token");
      return Response.json({ token: "job-token", refresh_token: "refresh-token", expires_in: 3_600_000 });
    }
    if (url.pathname.endsWith("/userinfo")) return Response.json({ email: "user@example.test" });
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  const start = 1_700_000_000_000;
  const signIn = await device.qoderDeviceSignIn({ fetch: fetcher, now: () => start, wait: async () => {} });
  const authorization = new URL(signIn.url);
  assert.equal(authorization.origin, "https://qoder.com");
  assert.equal(authorization.searchParams.get("challenge_method"), "S256");
  const result = await signIn.callback();
  const poll = calls.find(({ url }) => url.pathname.endsWith("/deviceToken/poll"));
  const expectedChallenge = createHash("sha256").update(poll.url.searchParams.get("verifier")).digest("base64url");
  assert.equal(authorization.searchParams.get("challenge"), expectedChallenge);
  assert.equal(poll.url.searchParams.get("nonce"), authorization.searchParams.get("nonce"));
  assert.deepEqual(result, {
    type: "success", access: "job-token", refresh: "refresh-token",
    expires: start + 3_600_000, accountId: "user@example.test",
  });
  assert.equal(polls, 2);
});

test("SDK job-token callback refreshes an expiring browser credential once and saves the new pair", async () => {
  const originalFetch = globalThis.fetch;
  let refreshCalls = 0;
  let saves = 0;
  let stored = {
    type: "oauth", access: "old-job", refresh: "old-refresh",
    expires: Date.now() + 1_000, accountId: "user@example.test",
  };
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(input).pathname, "/api/v1/jobToken/refresh");
    assert.equal(JSON.parse(init.body).refresh_token, "old-refresh");
    refreshCalls += 1;
    return Response.json({ token: "new-job", refresh_token: "new-refresh", expires_in: 3_600_000 });
  };
  sdkAuth.configureBrowserAuth({
    accountId: stored.accountId,
    read: async () => stored,
    write: async (value) => { stored = value; saves += 1; },
  });
  try {
    assert.equal(sdkAuth.hasQoderCredential({}), true);
    const auth = sdkAuth.qoderAuth({ QODER_AUTH_MODE: "browser" });
    assert.equal(auth.type, "jobToken");
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      auth.fetchJobToken({ requestId: "one", reason: "expiring" }, { signal }),
      auth.fetchJobToken({ requestId: "two", reason: "expiring" }, { signal }),
    ]);
    assert.equal(first.token, "new-job");
    assert.equal(second.token, "new-job");
    assert.equal(stored.refresh, "new-refresh");
    assert.equal(refreshCalls, 1);
    assert.equal(saves, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PAT remains the first authentication choice when it is configured", () => {
  sdkAuth.configureBrowserAuth({
    read: async () => null,
    write: async () => {},
  });
  assert.equal(sdkAuth.qoderAuth({ QODER_PERSONAL_ACCESS_TOKEN: "pt-test" }).type, "accessToken");
  assert.equal(sdkAuth.qoderAuth({ QODER_AUTH_MODE: "cli" }).type, "qodercli");
  assert.equal(sdkAuth.qoderAuth({ QODER_AUTH_MODE: "browser" }).type, "jobToken");
  assert.equal(sdkAuth.qoderAuth({ QODER_REGION: "cn" }).type, "qodercli");
});

test("an existing CLI login wins over browser sign-in unless browser mode is selected", async () => {
  const root = await mkdtemp(join(tmpdir(), "qoder-auth-priority-"));
  const originalHome = process.env.HOME;
  try {
    await mkdir(join(root, ".qoder", ".auth"), { recursive: true });
    await writeFile(join(root, ".qoder", ".auth", "user"), "local-login");
    process.env.HOME = root;
    sdkAuth.configureBrowserAuth({
      read: async () => ({ type: "oauth", access: "browser-job", refresh: "browser-refresh", expires: Date.now() + 60_000 }),
      write: async () => {},
    });
    assert.equal(sdkAuth.qoderAuth({}).type, "qodercli");
    assert.equal(sdkAuth.qoderAuth({ QODER_AUTH_MODE: "browser" }).type, "jobToken");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("a separate process can use and refresh OpenCode's saved browser sign-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "qoder-browser-auth-"));
  const environment = { XDG_DATA_HOME: root, QODER_AUTH_MODE: "browser" };
  const directory = join(root, "opencode");
  const file = join(directory, "auth.json");
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(directory);
    await writeFile(file, JSON.stringify({
      qoder: { type: "oauth", access: "stored-job", refresh: "stored-refresh", expires: Date.now() + 1_000, accountId: "saved@example.test" },
      openrouter: { type: "api", key: "other-provider-key" },
    }), { mode: 0o600 });
    globalThis.fetch = async () => Response.json({ token: "rotated-job", refresh_token: "rotated-refresh", expires_in: 3_600_000 });
    const auth = sdkAuth.qoderAuth(environment);
    assert.equal(auth.type, "jobToken");
    const result = await auth.fetchJobToken({ requestId: "standalone", reason: "expiring" }, { signal: new AbortController().signal });
    assert.equal(result.token, "rotated-job");
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.qoder.refresh, "rotated-refresh");
    assert.deepEqual(saved.openrouter, { type: "api", key: "other-provider-key" });
    assert.equal(sdkAuth.browserAuthIdentity(environment), "saved@example.test");
    delete saved.qoder;
    await writeFile(file, JSON.stringify(saved));
    assert.equal(sdkAuth.browserAuthIdentity(environment), undefined);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
