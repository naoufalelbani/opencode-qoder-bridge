import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("packed npm artifact installs and exposes its documented entrypoints", async () => {
  const temp = mkdtempSync(join(tmpdir(), "qoder-bridge-package-"));
  try {
    execFileSync("npm", ["init", "--yes"], { cwd: temp, stdio: "pipe" });
    const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", temp], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim().split(/\r?\n/).at(-1);
    assert.ok(tarball, "npm pack must produce a tarball");
    execFileSync("npm", ["install", "--ignore-scripts", "--no-package-lock", join(temp, tarball)], {
      cwd: temp,
      stdio: "pipe",
    });

    const packageRoot = join(temp, "node_modules", "opencode-qoder-bridge");
    const plugin = await import(pathToFileURL(join(packageRoot, "dist", "index.js")));
    const provider = await import(pathToFileURL(join(packageRoot, "dist", "provider.js")));
    const errors = await import(pathToFileURL(join(packageRoot, "dist", "errors.js")));
    assert.equal(typeof plugin.default, "function");
    assert.equal(typeof provider.createQoderProvider, "function");
    assert.equal(typeof errors.QoderSdkResultError, "function");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
