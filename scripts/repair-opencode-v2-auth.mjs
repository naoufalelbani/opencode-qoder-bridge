#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dryRun = process.argv.includes("--dry-run");
const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const opencodeHome = path.join(configHome, "opencode");
const pluginDir = path.join(opencodeHome, "plugins", "qoder-bridge");
const pluginEntry = path.join(pluginDir, "index.js");
const disabledEntry = `${pluginEntry}.disabled`;
const configPath = path.join(opencodeHome, "opencode.json");
const bridgeEntry = pathToFileURL(path.resolve("dist/index.js")).href;

if (!fs.existsSync(path.resolve("dist/index.js"))) {
  throw new Error("Run this script from the opencode-qoder-bridge checkout after building it.");
}

if (!fs.existsSync(pluginEntry) && !fs.existsSync(disabledEntry)) {
  throw new Error(`Neither ${pluginEntry} nor ${disabledEntry} exists; refusing to create a global plugin entry unexpectedly.`);
}

let config;
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} else {
  throw new Error(`OpenCode config not found: ${configPath}`);
}

const pluginList = Array.isArray(config.plugin) ? config.plugin : [];
const filteredPlugins = pluginList.filter((entry) =>
  !(typeof entry === "string" && /(?:^|\/)magpie-qoder(?:-0\.2\.\d+)?(?:\/plugin\.mjs)?$/.test(entry))
);
const configChanged = filteredPlugins.length !== pluginList.length;
if (configChanged) {
  if (filteredPlugins.length) config.plugin = filteredPlugins;
  else delete config.plugin;
}

const entryContent = `export { default } from ${JSON.stringify(bridgeEntry)};\n`;
const activeContent = fs.existsSync(pluginEntry) ? fs.readFileSync(pluginEntry, "utf8") : "";
const entryChanged = activeContent !== entryContent;

if (dryRun) {
  console.log(`Would ${entryChanged ? "write" : "keep"} ${pluginEntry}`);
  console.log(`${configChanged ? "Would remove" : "Would keep"} the Magpie plugin entry in ${configPath}`);
  process.exit(0);
}

fs.mkdirSync(pluginDir, { recursive: true });
if (entryChanged) fs.writeFileSync(pluginEntry, entryContent, { mode: 0o644 });

if (configChanged) {
  const backupPath = `${configPath}.before-qoder-bridge-v2-${new Date().toISOString().replaceAll(":", "-")}.bak`;
  fs.copyFileSync(configPath, backupPath);
  const mode = fs.statSync(configPath).mode & 0o777;
  const tempPath = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode });
  fs.renameSync(tempPath, configPath);
  console.log(`Saved config backup: ${backupPath}`);
}

console.log(`Enabled OpenCode 2 bridge plugin: ${pluginEntry}`);
console.log(configChanged ? "Removed the stale Magpie plugin config entry." : "No Magpie plugin config entry needed removal.");
console.log("Restart OpenCode, then run: opencode auth login qoder --method oauth");
