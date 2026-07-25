#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_FILE = join(homedir(), ".config", "opencode-qoder-bridge", "usage.json");

function fmt(usd) {
  return `$${(usd ?? 0).toFixed(4)}`;
}

function main() {
  let state = null;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    process.stdout.write("qoder: no usage yet");
    return;
  }

  const parts = [
    `cost ${fmt(state.totalCostUsd)}`,
    `turns ${state.turnCount ?? 0}`,
    `tok ${(state.totalInputTokens ?? 0) + (state.totalOutputTokens ?? 0)}`,
  ];

  const last = Array.isArray(state.recent) ? state.recent.at(-1) : null;
  if (last?.model) parts.push(`last ${last.model}`);

  process.stdout.write(`qoder: ${parts.join(" · ")}`);
}

main();
