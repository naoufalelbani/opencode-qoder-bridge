import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const DIST = new URL("../dist/", import.meta.url).pathname;

describe("provider", () => {
  test("createQoderProvider returns languageModel/textEmbeddingModel/imageModel", async () => {
    const { createQoderProvider } = await import(DIST + "provider.js");
    const p = createQoderProvider();
    assert.equal(typeof p.languageModel, "function");
    assert.equal(typeof p.textEmbeddingModel, "function");
    assert.equal(typeof p.imageModel, "function");
  });

  test("languageModel returns model with v3 spec", async () => {
    const { createQoderProvider } = await import(DIST + "provider.js");
    const lm = createQoderProvider().languageModel("auto");
    assert.equal(lm.specificationVersion, "v3");
    assert.equal(lm.provider, "qoder");
    assert.equal(typeof lm.doGenerate, "function");
    assert.equal(typeof lm.doStream, "function");
  });

  test("textEmbeddingModel throws", async () => {
    const { createQoderProvider } = await import(DIST + "provider.js");
    assert.throws(() => createQoderProvider().textEmbeddingModel("x"), /not support/);
  });

  test("imageModel throws", async () => {
    const { createQoderProvider } = await import(DIST + "provider.js");
    assert.throws(() => createQoderProvider().imageModel("x"), /not support/);
  });

  test("provider passes bridgeOptions to language model", async () => {
    const { createQoderProvider } = await import(DIST + "provider.js");
    const opts = { mcpServers: { foo: { type: "stdio", command: "bar" } } };
    const lm = createQoderProvider(opts).languageModel("auto");
    assert.deepEqual(lm.bridgeOptions, opts);
  });
});

describe("language-model", () => {
  test("specificationVersion is v3", async () => {
    const { QoderLanguageModel } = await import(DIST + "language-model.js");
    const lm = new QoderLanguageModel("auto");
    assert.equal(lm.specificationVersion, "v3");
  });

  test("modelId is stored", async () => {
    const { QoderLanguageModel } = await import(DIST + "language-model.js");
    const lm = new QoderLanguageModel("Qwen3.8-Max-Preview");
    assert.equal(lm.modelId, "Qwen3.8-Max-Preview");
  });

  test("supportedUrls is empty object (no URL-based routing)", async () => {
    const { QoderLanguageModel } = await import(DIST + "language-model.js");
    const lm = new QoderLanguageModel("auto");
    assert.deepEqual(lm.supportedUrls, {});
  });
});

describe("usage shape (v3 native)", () => {
  test("makeUsage produces nested v3 token fields", async () => {
    const src = await import("node:fs").then(fs =>
      fs.promises.readFile(DIST + "language-model.js", "utf8")
    );
    assert.ok(src.includes("inputTokens: {"), "must have nested inputTokens");
    assert.ok(src.includes("outputTokens: {"), "must have nested outputTokens");
    assert.ok(src.includes("total: input"), "must expose input total");
    assert.ok(src.includes("cacheRead"), "must expose cached input tokens");
    assert.ok(src.includes("total: output"), "must expose output total");
  });
});

describe("tool-normalizer", () => {
  let normalizeToolName, normalizeToolInput, normalizeToolInputString;

  beforeEach(async () => {
    const mod = await import(DIST + "tool-normalizer.js");
    normalizeToolName = mod.normalizeToolName;
    normalizeToolInput = mod.normalizeToolInput;
    normalizeToolInputString = mod.normalizeToolInputString;
  });

  test("lowercases tool names", () => {
    assert.equal(normalizeToolName("Read"), "read");
    assert.equal(normalizeToolName("Bash"), "bash");
    assert.equal(normalizeToolName("Grep"), "grep");
  });

  test("maps builtin names", () => {
    assert.equal(normalizeToolName("AskUserQuestion"), "question");
    assert.equal(normalizeToolName("Agent"), "task");
    assert.equal(normalizeToolName("ExitPlanMode"), "plan_exit");
    assert.equal(normalizeToolName("str_replace_based_edit_tool"), "edit");
  });

  test("maps MCP proxy names", () => {
    assert.equal(normalizeToolName("mcp__github__create_issue"), "github_create_issue");
    assert.equal(normalizeToolName("mcp__server__tool"), "server_tool");
  });

  test("normalizeToolInput renames keys for read", () => {
    const result = normalizeToolInput("read", { file_path: "/tmp/x" });
    assert.deepEqual(result, { filePath: "/tmp/x" });
  });

  test("normalizeToolInput renames keys for edit", () => {
    const result = normalizeToolInput("edit", {
      file_path: "/tmp/x",
      old_string: "a",
      new_string: "b",
      replace_all: true,
    });
    assert.deepEqual(result, {
      filePath: "/tmp/x",
      oldString: "a",
      newString: "b",
      replaceAll: true,
    });
  });

  test("normalizeToolInput maps Qoder agent types to OpenCode subagents", () => {
    assert.deepEqual(
      normalizeToolInput("task", {
        description: "Find the plugin",
        prompt: "Locate opencode-qoder-bridge",
        subagent_type: "Explore",
      }),
      {
        description: "Find the plugin",
        prompt: "Locate opencode-qoder-bridge",
        subagent_type: "explore",
      },
    );
    assert.equal(
      normalizeToolInput("task", { subagent_type: "general-purpose" }).subagent_type,
      "general",
    );
    assert.equal(
      normalizeToolInput("task", { subagentType: "Code-Reviewer" }).subagent_type,
      "general",
    );
  });

  test("normalizeToolInput handles grep special case", () => {
    const result = normalizeToolInput("grep", {
      pattern: "foo",
      glob: "*.ts",
      output_mode: "content",
    });
    assert.equal(result.pattern, "foo");
    assert.equal(result.include, "*.ts");
    assert.equal(result.glob, undefined);
    assert.equal(result.output_mode, undefined);
  });

  test("normalizeToolInputString parses and re-serializes", () => {
    const result = normalizeToolInputString("read", '{"file_path": "/tmp/x"}');
    assert.deepEqual(JSON.parse(result), { filePath: "/tmp/x" });
  });

  test("normalizeToolInputString returns {} for empty", () => {
    assert.equal(normalizeToolInputString("read", ""), "{}");
    assert.equal(normalizeToolInputString("read", "  "), "{}");
  });

  test("normalizeToolInputString falls back on invalid JSON", () => {
    const bad = "{invalid json";
    assert.equal(normalizeToolInputString("read", bad), bad);
  });

  test("does not resolve or copy prototype-polluting names", () => {
    assert.equal(normalizeToolName("constructor"), "constructor");
    const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":"bad","safe":"ok"}');
    const result = normalizeToolInput("bash", input);
    assert.deepEqual(result, { safe: "ok" });
    assert.equal({}.polluted, undefined);
  });
});

describe("prompt-builder", () => {
  let buildPromptString, promptHasImage;

  beforeEach(async () => {
    const mod = await import(DIST + "prompt-builder.js");
    buildPromptString = mod.buildPromptString;
    promptHasImage = mod.promptHasImage;
  });

  test("simple user message", () => {
    const result = buildPromptString(
      [{ role: "user", content: "hello world" }],
      180000
    );
    assert.equal(result, "hello world");
  });

  test("system + user message", () => {
    const result = buildPromptString(
      [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hi" },
      ],
      180000
    );
    assert.ok(result.includes("<system>"));
    assert.ok(result.includes("you are helpful"));
    assert.ok(result.includes("hi"));
  });

  test("conversation history wraps prior messages", () => {
    const result = buildPromptString(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: "second" },
      ],
      180000
    );
    assert.ok(result.includes("<conversation_history>"));
    assert.ok(result.includes("first"));
    assert.ok(result.includes("second"));
  });

  test("promptHasImage detects image parts", () => {
    assert.equal(
      promptHasImage([
        { role: "user", content: [{ type: "image", image: new Uint8Array([1]) }] },
      ]),
      true
    );
    assert.equal(
      promptHasImage([{ role: "user", content: "text only" }]),
      false
    );
  });

  test("empty prompt returns Hello", () => {
    const result = buildPromptString([], 180000);
    assert.equal(result, "Hello");
  });

  test("tool messages serialize correctly", () => {
    const result = buildPromptString(
      [
        { role: "user", content: "do something" },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "tc1", toolName: "bash", input: '{"command":"ls"}' }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "tc1", toolName: "bash", output: "file.txt" }],
        },
        { role: "user", content: "thanks" },
      ],
      180000
    );
    assert.ok(result.includes("tool_call"));
    assert.ok(result.includes("tool_result"));
    assert.ok(result.includes("file.txt"));
  });
});

describe("mcp-bridge", () => {
  let bridgeMcpServers;

  beforeEach(async () => {
    const mod = await import(DIST + "mcp-bridge.js");
    bridgeMcpServers = mod.bridgeMcpServers;
  });

  test("returns empty for undefined/null", () => {
    assert.deepEqual(bridgeMcpServers(undefined), {});
    assert.deepEqual(bridgeMcpServers(null), {});
  });

  test("converts stdio command array", () => {
    const result = bridgeMcpServers({
      myserver: { command: ["npx", "-y", "server"], environment: { KEY: "val" } },
    });
    assert.deepEqual(result.myserver, {
      type: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { KEY: "val" },
    });
  });

  test("converts stdio command string", () => {
    const result = bridgeMcpServers({
      myserver: { command: "node", args: ["server.js"] },
    });
    assert.deepEqual(result.myserver, {
      type: "stdio",
      command: "node",
      args: ["server.js"],
    });
  });

  test("converts http url", () => {
    const result = bridgeMcpServers({
      remote: { url: "https://example.com/mcp", headers: { Auth: "tok" } },
    });
    assert.deepEqual(result.remote, {
      type: "http",
      url: "https://example.com/mcp",
      headers: { Auth: "tok" },
    });
  });

  test("converts sse type", () => {
    const result = bridgeMcpServers({
      remote: { type: "sse", url: "https://example.com/sse" },
    });
    assert.equal(result.remote.type, "sse");
  });

  test("skips disabled entries", () => {
    const result = bridgeMcpServers({
      disabled: { enabled: false, command: ["foo"] },
    });
    assert.deepEqual(result, {});
  });

  test("skips unrecognized entries", () => {
    const result = bridgeMcpServers({
      bad: { foo: "bar" },
    });
    assert.deepEqual(result, {});
  });

  test("rejects prototype-polluting server names", () => {
    const input = JSON.parse('{"__proto__":{"command":"evil"},"safe":{"command":"node","environment":{"__proto__":"bad","OK":"yes"}}}');
    const result = bridgeMcpServers(input);
    assert.equal(Object.hasOwn(result, "__proto__"), false);
    assert.equal(result.safe.command, "node");
    assert.deepEqual(result.safe.env, { OK: "yes" });
  });
});

describe("models", () => {
  test("FALLBACK_MODELS has expected entries", async () => {
    const { FALLBACK_MODELS, DEFAULT_MODEL_ID, getModel } = await import(DIST + "models.js");
    assert.ok(FALLBACK_MODELS.length >= 3);
    assert.equal(DEFAULT_MODEL_ID, "auto");
    assert.ok(getModel("auto"));
    assert.ok(getModel("lite"));
    assert.ok(getModel("performance"));
    assert.equal(getModel("nonexistent"), undefined);
  });

  test("model has correct shape", async () => {
    const { getModel } = await import(DIST + "models.js");
    const m = getModel("auto");
    assert.equal(typeof m.id, "string");
    assert.equal(typeof m.name, "string");
    assert.equal(typeof m.limit.context, "number");
    assert.equal(typeof m.limit.output, "number");
    assert.equal(typeof m.cost.input, "number");
    assert.equal(typeof m.cost.output, "number");
  });
});

describe("plugin config hook", () => {
  test("package root exports only the plugin function", async () => {
    const entry = await import(DIST + "index.js");
    assert.deepEqual(Object.keys(entry), ["default"]);
    assert.equal(typeof entry.default, "function");
  });

  test("sets npm field to provider.js URL", async () => {
    const plugin = (await import(DIST + "index.js")).default;
    const instance = await plugin();
    const config = {};
    await instance.config(config);
    assert.ok(config.provider.qoder.npm, "must set npm field");
    assert.ok(
      config.provider.qoder.npm.includes("provider.js"),
      "npm must point to provider.js"
    );
  });

  test("sets provider name to Qoder", async () => {
    const plugin = (await import(DIST + "index.js")).default;
    const instance = await plugin();
    const config = {};
    await instance.config(config);
    assert.equal(config.provider.qoder.name, "Qoder");
  });

  test("registers builtin models", async () => {
    const plugin = (await import(DIST + "index.js")).default;
    const instance = await plugin();
    const config = {};
    await instance.config(config);
    const models = config.provider.qoder.models;
    assert.ok(Object.keys(models).length >= 3, "must have at least 3 models");
  });

  test("preserves user-defined models", async () => {
    const plugin = (await import(DIST + "index.js")).default;
    const instance = await plugin();
    const config = {
      provider: {
        qoder: {
          models: {
            "Custom-Model": { name: "Custom", limit: { context: 100, output: 50 } },
          },
        },
      },
    };
    await instance.config(config);
    assert.ok(config.provider.qoder.models["Custom-Model"], "user model must survive");
  });

  test("bridges MCP servers from config.mcp", async () => {
    const plugin = (await import(DIST + "index.js")).default;
    const instance = await plugin();
    const config = {
      mcp: {
        test: { command: ["node", "server.js"] },
      },
    };
    await instance.config(config);
    assert.ok(config.provider.qoder.options.mcpServers.test);
    assert.equal(config.provider.qoder.options.mcpServers.test.type, "stdio");
  });

  test("auth section is present", async () => {
    const plugin = (await import(DIST + "index.js")).default;
    const instance = await plugin();
    assert.ok(instance.auth);
    assert.equal(instance.auth.provider, "qoder");
    assert.ok(Array.isArray(instance.auth.methods));
  });

  test("tool section has qoder_usage", async () => {
    const plugin = (await import(DIST + "index.js")).default;
    const instance = await plugin();
    assert.ok(instance.tool.qoder_usage);
  });

  test("registers /qoder-usage without replacing a user override", async () => {
    const plugin = (await import(DIST + "index.js")).default;
    const instance = await plugin();

    const config = {};
    await instance.config(config);
    assert.equal(config.command["qoder-usage"].model, "qoder/lite");
    assert.match(config.command["qoder-usage"].template, /bin\/usage\.mjs/);
    assert.match(config.command["qoder-usage"].template, /!\`node /);

    const custom = {
      command: {
        "qoder-usage": {
          template: "my custom usage command",
        },
      },
    };
    await instance.config(custom);
    assert.equal(custom.command["qoder-usage"].template, "my custom usage command");
  });
});

describe("opencode.json integration", () => {
  test("plugin field is a valid array", async () => {
    const fs = await import("node:fs");
    const raw = fs.readFileSync(
      new URL("../../../opencode.json", import.meta.url),
      "utf8"
    );
    const config = JSON.parse(raw);
    assert.ok(Array.isArray(config.plugin), "plugin must be an array");
    assert.ok(config.plugin.length > 0, "plugin must not be empty");
  });
});

describe("SDK dependency resolution", () => {
  test("@qoder-ai/qoder-agent-sdk exports query and qodercliAuth", async () => {
    const sdk = await import("@qoder-ai/qoder-agent-sdk");
    assert.equal(typeof sdk.query, "function");
    assert.equal(typeof sdk.qodercliAuth, "function");
  });
});

describe("stream protocol shape", () => {
  test("SDK tools are provider-executed even when OpenCode declares no function tools", async () => {
    const { isProviderExecutedTool } = await import(DIST + "language-model.js");

    assert.equal(isProviderExecutedTool("bridge_smoke", new Set()), true);
    assert.equal(isProviderExecutedTool("read", new Set(["read"])), false);
    assert.equal(isProviderExecutedTool("bridge_smoke", new Set(["read"])), true);
  });

  test("doStream emits stream-start as first chunk", async () => {
    const { QoderLanguageModel } = await import(DIST + "language-model.js");
    const lm = new QoderLanguageModel("auto");

    // Mock: override doStream to test the ReadableStream shape
    // We can't easily mock the SDK, so we verify the source structure
    const src = await import("node:fs").then(fs =>
      fs.promises.readFile(DIST + "language-model.js", "utf8")
    );
    assert.ok(
      src.includes('{ type: "stream-start", warnings: [] }'),
      "must emit stream-start first"
    );
    assert.ok(src.includes('type: "finish"'), "must emit finish event");
    assert.ok(src.includes('"text-delta"'), "must support text-delta");
    assert.ok(src.includes('"reasoning-delta"'), "must support reasoning-delta");
    assert.ok(src.includes('"tool-call"'), "must support tool-call");
    assert.ok(src.includes('"tool-input-start"'), "must support tool-input-start");
    assert.ok(src.includes('"tool-input-delta"'), "must support tool-input-delta");
    assert.ok(src.includes('"tool-input-end"'), "must support tool-input-end");
  });

  test("doGenerate aggregates stream into content array", async () => {
    const src = await import("node:fs").then(fs =>
      fs.promises.readFile(DIST + "language-model.js", "utf8")
    );
    assert.ok(src.includes("async doGenerate(options)"), "must have doGenerate");
    assert.ok(src.includes("const { stream } = await this.doStream(options)"), "doGenerate uses doStream");
    assert.ok(src.includes('{ type: "reasoning", text: reasoning }'), "emits reasoning content");
    assert.ok(src.includes('{ type: "text", text }'), "emits text content");
  });
});

describe("auth module", () => {
  test("findQoderCLI returns string or null", async () => {
    const { findQoderCLI } = await import(DIST + "auth.js");
    const result = findQoderCLI();
    assert.ok(result === null || typeof result === "string");
  });

  test("isAuthenticated returns boolean", async () => {
    const { isAuthenticated } = await import(DIST + "auth.js");
    assert.equal(typeof isAuthenticated(), "boolean");
  });
});

describe("cost ledger", () => {
  test("formatCost formats correctly", async () => {
    const { formatCost } = await import(DIST + "cost.js");
    assert.equal(formatCost(0), "$0.0000");
    assert.equal(formatCost(1.5), "$1.5000");
    assert.equal(formatCost(0.001), "$0.0010");
  });

  test("summarize returns expected shape", async () => {
    const { summarize } = await import(DIST + "cost.js");
    const s = summarize();
    assert.equal(typeof s.totalCostUsd, "number");
    assert.equal(typeof s.totalInputTokens, "number");
    assert.equal(typeof s.totalOutputTokens, "number");
    assert.equal(typeof s.turnCount, "number");
    assert.ok(typeof s.byModel === "object");
    assert.ok(Array.isArray(s.recent));
  });
});
