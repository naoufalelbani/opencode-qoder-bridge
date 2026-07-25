#!/usr/bin/env node
import { getLiveUsage, formatUsageReport } from "../dist/usage.js";
import { summarize, formatCost } from "../dist/cost.js";

async function main() {
  const lines = [];
  const live = await getLiveUsage(true);
  lines.push(
    live
      ? formatUsageReport(live)
      : "Live Qoder usage unavailable (not logged in or Qoder CLI missing).",
  );

  const summary = summarize();
  lines.push("");
  lines.push("Local Usage Ledger");
  lines.push(`  Reference cost: ${formatCost(summary.totalCostUsd)}`);
  lines.push(`  Turns: ${summary.turnCount}`);
  lines.push(`  Tokens: ${summary.totalInputTokens} in / ${summary.totalOutputTokens} out`);

  const models = Object.entries(summary.byModel);
  if (models.length > 0) {
    lines.push("  By model:");
    for (const [name, bucket] of models) {
      lines.push(`    ${name}: ${formatCost(bucket.costUsd)} (${bucket.turns} turns)`);
    }
  }

  process.stdout.write(lines.join("\n"));
}

main().catch((error) => {
  process.stderr.write(`Unable to read Qoder usage: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
