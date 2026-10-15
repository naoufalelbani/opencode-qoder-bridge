import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", path.sep);

/** Minimal OpenCode 2 plugin context capturing every transform we register. */
function mockContext(options = {}, savedConnections = []) {
  const captured = {
    mcp: [],
    provider: [],
    aisdk: [],
    tool: [],
    integration: [],
    methods: [],
    integrations: [],
  };
  const registrations = [];
  const track = (bucket, callback) => {
    const registration = { callback, disposed: false };
    bucket.push(registration);
    registrations.push(registration);
    return Promise.resolve({ dispose: async () => { registration.disposed = true; } });
  };

  const editor = {
    list: () => [],
    get: () => undefined,
  };

  const context = {
    options,
    location: { directory: process.cwd() },
    app: { version: "test" },
    mcp: {
      transform: (callback) => track(captured.mcp, callback),
      list: async () => [],
    },
    provider: {
      transform: (callback) => track(captured.provider, callback),
      list: async () => [],
    },
    aisdk: { hook: (_name, callback) => track(captured.aisdk, callback) },
    tool: {
      transform: (callback) => track(captured.tool, callback),
      list: async () => [],
    },
    integration: {
      transform: (callback) => track(captured.integration, callback),
      get: async () => ({ data: { connections: savedConnections } }),
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
    event: {
      subscribe: ({ signal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
        },
      }),
    },
  };

  return { context, captured, registrations, editor };
}

async function runSetup(t, options = {}, savedConnections = []) {
  const mock = mockContext(options, savedConnections);
  const { setup } = await import(DIST + "v2.js");
  const cleanup = await setup(mock.context);

  const provider = { info: undefined, models: [] };
  for (const registration of mock.captured.provider) {
    const draft = {
      added: undefined,
      updated: undefined,
      models: undefined,
      get: () => undefined,
      add: (input) => { draft.added = input; },
      update: (id, mutate) => { draft.updated = { id, mutate }; },
      models: { set: (id, models) => { draft.models = { id, models }; } },
    };
    registration.callback(draft);
    if (draft.added) {
      provider.info = draft.added.info;
      provider.models = draft.added.models;
    } else if (draft.models) {
      provider.models = draft.models.models;
    }
  }

  const tools = [];
  for (const registration of mock.captured.tool) {
    const added = [];
    registration.callback({ add: (tool) => added.push(tool), list: () => [], get: () => undefined, update() {}, remove() {}, namespace() {} });
    tools.push(...added);
  }

  const methods = [];
  for (const registration of mock.captured.integration) {
    registration.callback({
      list: () => [],
      get: () => undefined,
      update(id, mutate) {
        const integration = { id, name: "" };
        mutate(integration);
        mock.captured.integrations.push(integration);
      },
      remove() {},
      method: {
        list: () => [],
        update: (input) => methods.push(input),
        remove() {},
      },
    });
  }

  t.after(cleanup);
  return { cleanup, provider, tools, methods, mock };
}

describe("OpenCode 2 provider", () => {
  test("publishes the qoder provider through OpenCode 2's AI SDK adapter", async (t) => {
    const { provider, cleanup, mock } = await runSetup(t);
    assert.ok(provider.info, "provider must be registered");
    assert.equal(provider.info.id, "qoder");
    assert.equal(provider.info.name, "Qoder");
    assert.equal(provider.info.activation, "enabled");
    assert.equal(provider.info.package, "aisdk:@ai-sdk/openai-compatible");
    assert.equal(typeof provider.info.settings.baseURL, "string");
    const event = {
      model: { providerID: "qoder", modelID: "lite" },
      options: {},
      sdk: {},
    };
    mock.captured.aisdk[0].callback(event);
    assert.equal(event.language?.modelId, "lite", "language hook must route inference to Qoder SDK");
    await cleanup();
  });

  test("registers the fallback catalog", async (t) => {
    const { provider, cleanup } = await runSetup(t);
    assert.ok(provider.models.length >= 3, "must register at least the fallback models");
    for (const model of provider.models) {
      assert.equal(model.providerID, "qoder");
      assert.ok(model.id, "model id is required");
      assert.ok(model.name, "model name is required");
      assert.ok(Number.isFinite(model.limit.context) && model.limit.context > 0);
      assert.ok(Number.isFinite(model.limit.output) && model.limit.output > 0);
      assert.equal(model.cost.length, 1);
      assert.ok(Array.isArray(model.capabilities.input) && model.capabilities.input.length > 0);
      assert.deepEqual(model.capabilities.output, ["text"]);
    }
    await cleanup();
  });

  test("registers the same tool names as the OpenCode 1 hook", async (t) => {
    const { tools, cleanup } = await runSetup(t);
    const v1 = (await import(DIST + "index.js")).default.server;
    // No argument: OpenCode 1 skips sidebar registration when the plugin is
    // invoked without a host context, which keeps this test hermetic.
    const hooks = await v1();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      Object.keys(hooks.tool).sort(),
      "V1 and V2 must expose the same Qoder tools",
    );
    for (const tool of tools) {
      assert.ok(tool.description, `${tool.name} needs a description`);
      assert.equal(typeof tool.execute, "function");
      assert.ok(tool.input, `${tool.name} needs an input schema`);
    }
    await cleanup();
  });

  test("registers the qoder integration methods", async (t) => {
    const { methods, cleanup, mock } = await runSetup(t);
    assert.deepEqual(mock.captured.integrations, [{ id: "qoder", name: "Qoder (opencode-qoder-bridge)" }]);
    const oauth = methods.find((method) => method.method.type === "oauth");
    const env = methods.find((method) => method.method.type === "env");
    const command = methods.find((method) => method.method.type === "command");
    assert.ok(oauth, "oauth method must be registered");
    assert.equal(oauth.method.label, "Sign in with Qoder via opencode-qoder-bridge");
    assert.equal(oauth.label({ type: "oauth", metadata: { accountId: "user@example.test" } }), "Qoder: user@example.test (opencode-qoder-bridge)");
    assert.equal(typeof oauth.authorize, "function");
    assert.equal(typeof oauth.refresh, "function");
    const vpc = methods.find((method) => method.method.id === "oauth-cn-vpc");
    assert.ok(vpc, "CN VPC sign-in method must be registered");
    assert.equal(vpc.method.form?.[0]?.key, "vpc");
    assert.deepEqual(env?.method.names, ["QODER_PERSONAL_ACCESS_TOKEN"]);
    assert.ok(Array.isArray(command?.method.command) && command.method.command.length > 0);
    await cleanup();
  });

  test("refuses a second saved Qoder account", async (t) => {
    const { methods, cleanup } = await runSetup(t, {}, [
      { type: "credential", id: "cred-existing", label: "user@example.test (opencode-qoder-bridge)", method: "oauth" },
    ]);
    const oauth = methods.find((method) => method.method.type === "oauth");
    await assert.rejects(
      oauth.authorize({}),
      /already connected as user@example\.test.*Remove that account first/,
    );
    await cleanup();
  });

  test("can disable the Qoder CLI and personal-token login methods", async (t) => {
    const { methods, cleanup } = await runSetup(t, { disableQoderCliLogin: true });
    assert.deepEqual(methods.map((method) => method.method.id), ["oauth", "oauth-cn", "oauth-cn-vpc"]);
    assert.ok(methods.every((method) => method.method.type === "oauth"));
    await cleanup();
  });

  test("disposes every registration on cleanup", async (t) => {
    const { cleanup, mock } = await runSetup(t);
    assert.ok(mock.registrations.length >= 4, "every domain must register a transform");
    await cleanup();
    for (const registration of mock.registrations) {
      assert.equal(registration.disposed, true);
    }
  });

  test("uses plugin options as provider settings", async (t) => {
    const { provider, cleanup } = await runSetup(t, { cwd: "/tmp", sessionKey: "demo" });
    assert.equal(provider.info.settings.cwd, "/tmp");
    assert.equal(provider.info.settings.sessionKey, "demo");
    await cleanup();
  });
});

describe("OpenCode 2 provider package", () => {
  test("exports the named model factory OpenCode 2 imports", async (t) => {
    const provider = await import(DIST + "provider.js");
    assert.equal(typeof provider.createQoderProvider, "function");
    assert.equal(typeof provider.model, "function");
    const instance = provider.model("auto", { cwd: process.cwd() });
    assert.equal(typeof instance, "object");
  });
});

describe("OpenCode 2 MCP bridge", () => {
  test("converts local and remote servers and skips disabled ones", async (t) => {
    const { bridgeMcpServersV2 } = await import(DIST + "mcp-bridge.js");
    const bridged = bridgeMcpServersV2([
      ["docs", { type: "local", command: ["node", "server.js"] }],
      ["remote", { type: "remote", url: "https://example.com/mcp" }],
      ["off", { type: "local", command: ["node", "off.js"], disabled: true }],
    ]);
    assert.equal(bridged.docs.type, "stdio");
    assert.equal(bridged.docs.command, "node");
    assert.deepEqual(bridged.docs.args, ["server.js"]);
    assert.equal(bridged.remote.type, "http");
    assert.equal(bridged.off, undefined);
  });
});

describe("OpenCode 2 sidebar", () => {
  test("exposes id, tui, and setup without a server hook", async (t) => {
    const entry = (await import(DIST + "tui.js")).default;
    assert.equal(entry.id, "opencode-qoder-bridge-sidebar");
    assert.equal(typeof entry.tui, "function");
    assert.equal(typeof entry.setup, "function");
    assert.equal(entry.server, undefined);
  });

  test("activates only once when OpenCode loads the module twice", async (t) => {
    const mod = await import(DIST + "tui.js");
    const started = [];
    const finished = [];
    const context = {
      options: {},
      location: { directory: process.cwd() },
      theme: {},
      data: {
        on: () => () => { finished.push("event"); },
        session: {
          get: () => undefined,
          cost: () => 0,
          message: { list: () => [] },
        },
      },
      keymap: { layer: () => {} },
      ui: {
        dialog: { alert: async () => {}, prompt: async () => undefined },
        toast: { show: () => {} },
        router: { current: () => ({ type: "home" }) },
        slot: (claim) => { started.push(claim.append); return () => { finished.push("slot"); }; },
      },
    };

    const first = await mod.setup(context);
    const second = await mod.setup(context);
    assert.equal(typeof first, "function", "the first load owns the sidebar");
    assert.equal(second, undefined, "a duplicate load must not render a second sidebar");
    assert.deepEqual(started, ["sidebar.content"]);

    await first();
    assert.ok(finished.includes("slot"), "cleanup must release the slot");
  });
});
