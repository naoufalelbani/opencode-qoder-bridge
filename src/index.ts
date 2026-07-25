import type { Hooks, Config, Plugin } from "@opencode-ai/plugin";
import { FALLBACK_MODELS, fetchDynamicModels } from "./models.js";
import type { DynamicModelEntry } from "./models.js";
import { isAuthenticated, findQoderCLI } from "./auth.js";
import { bridgeMcpServers } from "./mcp-bridge.js";
import { getLiveUsage, formatUsageReport } from "./usage.js";
import { summarize, formatCost } from "./cost.js";
import { ensureTuiRegistered } from "./tui-register.js";

const PROVIDER_URL = new URL("./provider.js", import.meta.url).href;
const USAGE_COMMAND = new URL("../bin/usage.mjs", import.meta.url);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildFallbackEntry(m: (typeof FALLBACK_MODELS)[number]) {
  return {
    name: m.name,
    attachment: m.attachment,
    reasoning: m.reasoning,
    temperature: false,
    tool_call: m.toolCall,
    limit: { context: m.limit.context, output: m.limit.output },
    cost: {
      input: m.cost.input,
      output: m.cost.output,
      cache_read: m.cost.cacheRead,
      cache_write: m.cost.cacheWrite,
    },
    modalities: {
      input: m.attachment ? ["text", "image"] : ["text"],
      output: ["text"],
    },
  };
}

function buildDynamicEntry(m: DynamicModelEntry) {
  return {
    name: m.name,
    attachment: m.attachment,
    reasoning: m.reasoning,
    temperature: false,
    tool_call: m.toolCall,
    limit: m.limit,
    cost: m.cost,
    modalities: m.modalities,
  };
}

const plugin: Plugin = async (input): Promise<Hooks> => {
  if (input) {
    try {
      const result = await ensureTuiRegistered();
      if (result === "added") {
        console.info("[opencode-qoder-bridge] Registered Qoder sidebar; restart OpenCode to activate it.");
      }
    } catch (error) {
      console.warn("[opencode-qoder-bridge] Could not register Qoder sidebar:", error);
    }
  }

  return {
    async config(config: Config) {
      config.provider ??= {};
      const existing = (config.provider.qoder ?? {}) as Record<string, any>;

      config.command ??= {};
      config.command["qoder-usage"] ??= {
        template:
          "This is output from the local qoder-usage CLI. Echo it in a fenced text block without interpreting it:\n\n"
          + `!\`node ${shellQuote(USAGE_COMMAND.pathname)}\``,
        description: "Show live Qoder credit quota and local usage totals",
        model: "qoder/lite",
      };

      const builtinModels: Record<string, unknown> = {};
      const dynamic = await fetchDynamicModels();
      if (dynamic) {
        for (const m of dynamic) {
          if (!UNSAFE_KEYS.has(m.id)) builtinModels[m.id] = buildDynamicEntry(m);
        }
      } else {
        for (const m of FALLBACK_MODELS) builtinModels[m.id] = buildFallbackEntry(m);
      }
      const mergedModels = { ...builtinModels, ...(existing.models ?? {}) };

      const bridgedMcp = bridgeMcpServers((config as Record<string, unknown>).mcp);
      const mergedOptions: Record<string, unknown> = { ...(existing.options ?? {}) };
      if (Object.keys(bridgedMcp).length > 0) {
        mergedOptions.mcpServers = {
          ...((existing.options as Record<string, any>)?.mcpServers ?? {}),
          ...bridgedMcp,
        };
      }

      config.provider.qoder = {
        ...existing,
        npm: existing.npm ?? PROVIDER_URL,
        name: existing.name ?? "Qoder",
        options: mergedOptions,
        models: mergedModels,
      } as Config["provider"] extends infer T ? T[keyof T] : never;
    },

    auth: {
      provider: "qoder",
      async loader() {
        return {};
      },
      methods: [
        {
          type: "api",
          label: "Open Qoder and log in, or run `qoder login` in your terminal",
          prompts: [],
          async authorize() {
            if (!findQoderCLI()) {
              return { type: "failed" };
            }
            if (isAuthenticated()) {
              return { type: "success", key: "qoder-cli-auth" };
            }
            return { type: "failed" };
          },
        },
      ],
    },

    tool: {
      qoder_usage: {
        description:
          "Show Qoder account usage and quota (live), plus accumulated session cost and token totals from the local ledger.",
        args: {},
        async execute() {
          const lines: string[] = [];

          const live = await getLiveUsage();
          lines.push(live ? formatUsageReport(live) : "Live usage unavailable (not logged in or CLI missing).");

          const s = summarize();
          lines.push("");
          lines.push("Local Cost Ledger");
          lines.push(`  Total cost: ${formatCost(s.totalCostUsd)}`);
          lines.push(`  Turns: ${s.turnCount}`);
          lines.push(`  Tokens: ${s.totalInputTokens} in / ${s.totalOutputTokens} out`);

          const models = Object.entries(s.byModel);
          if (models.length > 0) {
            lines.push("  By model:");
            for (const [name, b] of models) {
              lines.push(`    ${name}: ${formatCost(b.costUsd)} (${b.turns} turns)`);
            }
          }

          return { title: "Qoder Usage", output: lines.join("\n") };
        },
      },
    },
  };
};

export default plugin;
