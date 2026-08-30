#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Mirrors resolveStateDir() from src/state-dir.ts:
// QODER_BRIDGE_STATE_DIR > XDG_CONFIG_HOME > ~/.config.
function resolveStateDir(env = process.env) {
  const override = env.QODER_BRIDGE_STATE_DIR?.trim();
  if (override) return join(override);
  const configHome = env.XDG_CONFIG_HOME?.trim()
    || (process.platform === "win32" ? env.APPDATA?.trim() : undefined);
  return join(configHome || join(homedir(), ".config"), "opencode-qoder-bridge");
}

const STATE_FILE = join(resolveStateDir(), "usage.json");
const MAX_STATE_BYTES = 1_000_000;

function fmt(usd) {
  const n = typeof usd === "number" && Number.isFinite(usd) ? usd : 0;
  return `$${n.toFixed(4)}`;
}

function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function add(left, right) {
  const total = left + right;
  return Number.isFinite(total) ? total : Number.MAX_SAFE_INTEGER;
}

function main() {
  let state = null;
  try {
    const info = lstatSync(STATE_FILE);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) {
      process.stdout.write("qoder: no usage yet");
      return;
    }
    state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      process.stdout.write("qoder: no usage yet");
      return;
    }
  } catch {
    process.stdout.write("qoder: no usage yet");
    return;
  }

  const parts = [
    `cost ${fmt(state.totalCostUsd)}`,
    `turns ${count(state.turnCount)}`,
    `tok ${add(count(state.totalInputTokens), count(state.totalOutputTokens))}`,
  ];

  const last = Array.isArray(state.recent) ? state.recent.at(-1) : null;
  if (typeof last?.model === "string" && last.model) {
    const model = last.model.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 256);
    parts.push(`last ${model}`);
  }

  process.stdout.write(`qoder: ${parts.join(" · ")}`);
}

main();
