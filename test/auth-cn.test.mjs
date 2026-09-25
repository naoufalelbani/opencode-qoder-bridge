import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST_URL = new URL("../dist/", import.meta.url);
const DIST = DIST_URL.href;

const SAVED = {};

function saveEnv() {
  for (const key of ["HOME", "PATH", "QODER_REGION", "QODER_CLI_PATH"]) {
    SAVED[key] = process.env[key];
  }
}

function restoreEnv() {
  for (const key of ["HOME", "PATH", "QODER_REGION", "QODER_CLI_PATH"]) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
}

let fakeHome = null;

function makeExe(p) {
  mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
  writeFileSync(p, "#!/bin/sh\necho hi");
  chmodSync(p, 0o755);
}

function writeAuthFile(home, base) {
  const dir = join(home, base, ".auth");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "user"), "test-token");
}

async function freshAuth() {
  const auth = await import(DIST + "auth.js");
  auth.resetCachedCliPath();
  return auth;
}

describe("qoder region support (global + CN)", () => {
  beforeEach(() => {
    saveEnv();
    fakeHome = mkdtempSync(join(tmpdir(), "qoder-cn-test-"));
    process.env.HOME = fakeHome;
    process.env.PATH = "";
    delete process.env.QODER_REGION;
    delete process.env.QODER_CLI_PATH;
  });

  afterEach(async () => {
    restoreEnv();
    const auth = await import(DIST + "auth.js");
    auth.resetCachedCliPath();
    if (fakeHome) {
      rmSync(fakeHome, { recursive: true, force: true });
      fakeHome = null;
    }
  });

  test("isAuthenticated detects CN-only login", async () => {
    const auth = await freshAuth();
    writeAuthFile(fakeHome, ".qoder-cn");
    assert.equal(auth.isAuthenticated(), true);
  });

  test("isAuthenticated still detects global login", async () => {
    const auth = await freshAuth();
    writeAuthFile(fakeHome, ".qoder");
    assert.equal(auth.isAuthenticated(), true);
  });

  test("finds CN local binary when only CN is installed", async () => {
    const auth = await freshAuth();
    const cnLocal = join(fakeHome, ".qoder-cn", "local", "qoderclicn");
    makeExe(cnLocal);
    assert.equal(auth.findQoderCLI(true), cnLocal);
  });

  test("global local binary wins when both regions installed", async () => {
    const auth = await freshAuth();
    makeExe(join(fakeHome, ".qoder-cn", "local", "qoderclicn"));
    const globalLocal = join(fakeHome, ".qoder", "local", "qodercli");
    makeExe(globalLocal);
    assert.equal(auth.findQoderCLI(true), globalLocal);
  });

  test("PATH prefers qodercli over qoderclicn in the same directory", async () => {
    const auth = await freshAuth();
    const pathDir = mkdtempSync(join(tmpdir(), "qoder-cn-path-"));
    try {
      makeExe(join(pathDir, "qoderclicn"));
      process.env.PATH = pathDir;
      assert.equal(auth.findQoderCLI(true), join(pathDir, "qoderclicn"));
      makeExe(join(pathDir, "qodercli"));
      assert.equal(auth.findQoderCLI(true), join(pathDir, "qodercli"));
    } finally {
      rmSync(pathDir, { recursive: true, force: true });
    }
  });

  test("QODER_REGION=cn restricts discovery to CN", async () => {
    const auth = await freshAuth();
    const globalLocal = join(fakeHome, ".qoder", "local", "qodercli");
    const cnLocal = join(fakeHome, ".qoder-cn", "local", "qoderclicn");
    makeExe(globalLocal);
    makeExe(cnLocal);
    process.env.QODER_REGION = "cn";
    assert.equal(auth.findQoderCLI(true), cnLocal);
  });

  test("QODER_REGION=global restricts discovery to global", async () => {
    const auth = await freshAuth();
    const globalLocal = join(fakeHome, ".qoder", "local", "qodercli");
    const cnLocal = join(fakeHome, ".qoder-cn", "local", "qoderclicn");
    makeExe(globalLocal);
    makeExe(cnLocal);
    process.env.QODER_REGION = "global";
    assert.equal(auth.findQoderCLI(true), globalLocal);
  });

  test("QODER_REGION=cn with no CN install resolves to null", async () => {
    const auth = await freshAuth();
    makeExe(join(fakeHome, ".qoder", "local", "qodercli"));
    process.env.QODER_REGION = "cn";
    assert.equal(auth.findQoderCLI(true), null);
  });

  test("QODER_CLI_PATH override wins when executable", async () => {
    const auth = await freshAuth();
    makeExe(join(fakeHome, ".qoder", "local", "qodercli"));
    const customDir = mkdtempSync(join(tmpdir(), "qoder-cn-custom-"));
    try {
      const custom = join(customDir, "my-qoder");
      makeExe(custom);
      process.env.QODER_CLI_PATH = custom;
      assert.equal(auth.findQoderCLI(true), custom);
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  test("non-executable QODER_CLI_PATH falls back to discovery", async () => {
    const auth = await freshAuth();
    const globalLocal = join(fakeHome, ".qoder", "local", "qodercli");
    makeExe(globalLocal);
    process.env.QODER_CLI_PATH = join(fakeHome, "does-not-exist");
    assert.equal(auth.findQoderCLI(true), globalLocal);
  });

  test("versioned bins pick the latest version across regions", async () => {
    const auth = await freshAuth();
    makeExe(join(fakeHome, ".qoder", "bin", "qodercli", "qodercli-1.0.0"));
    const latest = join(fakeHome, ".qoder-cn", "bin", "qoderclicn", "qoderclicn-9.9.9");
    makeExe(latest);
    assert.equal(auth.findQoderCLI(true), latest);
  });

  test("versioned bins prefer global on version ties", async () => {
    const auth = await freshAuth();
    makeExe(join(fakeHome, ".qoder-cn", "bin", "qoderclicn", "qoderclicn-2.0.0"));
    const globalBin = join(fakeHome, ".qoder", "bin", "qodercli", "qodercli-2.0.0");
    makeExe(globalBin);
    assert.equal(auth.findQoderCLI(true), globalBin);
  });

  test("getQoderRegion classifies global, CN, and null", async () => {
    const auth = await freshAuth();
    assert.equal(auth.getQoderRegion("/home/u/.qoder/local/qodercli"), "global");
    assert.equal(auth.getQoderRegion("/home/u/.qoder-cn/local/qoderclicn"), "cn");
    assert.equal(auth.getQoderRegion(null), null);
  });

  test("regionPreference parses QODER_REGION with auto default", async () => {
    const auth = await freshAuth();
    assert.equal(auth.regionPreference({}), "auto");
    assert.equal(auth.regionPreference({ QODER_REGION: "cn" }), "cn");
    assert.equal(auth.regionPreference({ QODER_REGION: " CN " }), "cn");
    assert.equal(auth.regionPreference({ QODER_REGION: "GLOBAL" }), "global");
    assert.equal(auth.regionPreference({ QODER_REGION: "bogus" }), "auto");
  });

  test("cliLoginHint is region-aware", async () => {
    const auth = await freshAuth();
    assert.match(auth.cliLoginHint({}), /qoder login/);
    assert.match(auth.cliLoginHint({ QODER_REGION: "cn" }), /CN/);
  });
});
