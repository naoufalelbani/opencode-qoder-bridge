#!/usr/bin/env node
import { getLiveUsage, formatUsageReport } from "../dist/usage.js";
import { summarize, formatCost } from "../dist/cost.js";
import { describeError } from "../dist/logger.js";

async function main() {
  const lines = [];
  const live = await getLiveUsage(true);
  lines.push(
    live
      ? formatUsageReport(live)
      : "Live Qoder usage unavailable (not logged in or Qoder runtime unavailable).",
  );

  const summary = summarize();
  lines.push("");
  lines.push("Local Usage Ledger");
  lines.push(`  Reference cost: ${formatCost(summary?.totalCostUsd ?? 0)}`);
  lines.push(`  Turns: ${summary?.turnCount ?? 0}`);
  lines.push(`  Tokens: ${summary?.totalInputTokens ?? 0} in / ${summary?.totalOutputTokens ?? 0} out`);

  const models = Object.entries(summary?.byModel ?? {});
  if (models.length > 0) {
    lines.push("  By model:");
    for (const [name, bucket] of models) {
      lines.push(`    ${name}: ${formatCost(bucket.costUsd)} (${bucket.turns} turns)`);
    }
  }

  process.stdout.write(lines.join("\n"));
}

main().catch((error) => {
  process.stderr.write(`Unable to read Qoder usage: ${describeError(error)}\n`);
  process.exitCode = 1;
});
