# opencode-qoder-bridge

An [opencode](https://opencode.ai) plugin that bridges **Qoder AI** models into your terminal via the official [`@qoder-ai/qoder-agent-sdk`](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk).

A ground-up rewrite focused on reliability, performance, and first-class usage/cost visibility.

> [!IMPORTANT]
> This is an independent community project. It is not affiliated with,
> endorsed by, or sponsored by Qoder or OpenCode. Use of the Qoder SDK and
> services is subject to the [Qoder Product Service Terms](https://qoder.com/product-service).

## Highlights

- **Official SDK, no vendoring** — depends on `@qoder-ai/qoder-agent-sdk` directly. No patched SDK copies, no CLI compat-wrapper scripts.
- **Correct streaming** — native AI SDK v3 stream-part translation (`content_block_start/delta/stop`, `message_delta`, assistant fallback), reasoning blocks, and tool-call handoff to opencode.
- **Usage & cost tracking** — every completed turn is recorded to a local ledger (`~/.config/opencode-qoder-bridge/usage.json`) with per-model cost and token totals. Query it via the `qoder_usage` tool or the `opencode-qoder-bridge` statusline binary.
- **Live quota** — `qoder_usage` also pulls live account quota via the SDK's `getUsageInfo()` (cached 60s).
- **Reliable lifecycle** — proper abort propagation, idempotent cleanup, and external-abort vs. internal-error distinction so cancellations don't surface as errors.
- **Image input** — multimodal prompts are passed through the SDK's async-iterable path (base64, data URLs, `file://`, `~/`, and absolute paths).

## Quick start

1. Use Node.js 22.22.2 or newer, or Node.js 24.15.0 or newer.

2. Install OpenCode and this plugin:

   ```bash
   npm install -g opencode-ai
   npm install opencode-qoder-bridge
   ```

3. Authenticate with a Qoder PAT (recommended):

   ```bash
   export QODER_PERSONAL_ACCESS_TOKEN="pt-..."
   ```

   Or use the Qoder CLI login flow:

   ```bash
   qoder login
   ```

PAT authentication uses the SDK's worker runtime when available and does not
require a local `qoder login`. CLI authentication remains supported.

## Install

For a published npm installation, add this to
`~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-qoder-bridge"]
}
```

For a local checkout or an unpublished package, point OpenCode at the built
plugin entry directly:

```json
{
  "plugin": [
    "file:///absolute/path/to/opencode-qoder-bridge/dist/index.js"
  ]
}
```

opencode installs published npm plugins automatically on startup. A bare package
name must exist in the npm registry; installing an unpublished package only in
`~/.config/opencode/node_modules` is not enough for current opencode releases.
Once loaded, the plugin injects the `qoder` provider and all models — no manual
`provider` block required.

## Usage

```bash
opencode run -m qoder/lite "say hello"      # free model
opencode run -m qoder/auto "explain async/await"
opencode -m qoder/performance               # interactive
```

### Usage & cost

Run `qoder-usage` in a terminal for the live report, or add the statusline
binary to your OpenCode statusline config:

```bash
opencode-qoder-bridge
# qoder: cost $0.0123 · turns 1 · tok 1500 · last performance
```

The package also exports a TUI entry at `opencode-qoder-bridge/tui`. It shows
live Qoder credits only while the current session's selected provider is
`qoder`; it stays hidden and does not query quota for other providers. The
sidebar shows OpenCode's session spend with four-decimal precision and derives
fractional session Credits from Qoder's cent-denominated reference cost
(`session.cost * 100`). The value is marked with `~` because Qoder's personal
SDK exposes only a rounded whole-account quota, not its per-request Credits Log.
The authoritative account balance still comes from SDK `userQuota`, refreshing
after each completed Qoder turn and every 30 seconds while active.

OpenCode 1.18.5 loads server plugins and TUI plugins independently. On its
first load, the bridge safely adds its bundled TUI entry to the global
`tui.json`, preserving existing settings. Restart OpenCode once after initial
installation so the TUI loader can activate it. The resulting entry is
equivalent to:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///path/to/opencode-qoder-bridge/dist/tui.js"]
}
```

The ledger accumulates across sessions. Delete `~/.config/opencode-qoder-bridge/usage.json` to reset it.

## Models

The bridge discovers the available catalog at startup through the SDK's
`getAvailableModels()` API. Availability is account-, region-, rollout-, and
SDK-version-dependent. A live query on **2026-08-20** returned:

| Model ID | Name | Credit multiplier | Vision | Reasoning | Max input | Max output |
|----------|------|-------------------|--------|-----------|-----------|------------|

The following are known or historical model IDs. Some may be obsolete or
unavailable for a particular account and are not an availability guarantee:

| Model ID | Name | Credit multiplier | Vision | Reasoning | Max input | Max output |
|----------|------|-------------------|--------|-----------|-----------|------------|
| `auto` | Auto | 1.00x | ✓ | ✗ | 180K | 32K |
| `ultimate` | Ultimate | 0.80x | ✓ | ✓ | 1M | 32K |
| `performance` | Performance | 1.10x | ✓ | ✗ | 1M | 32K |
| `efficient` | Efficient | 0.30x | ✓ | ✗ | 180K | 32K |
| `lite` | Lite | 0.00x | ✗ | ✗ | 180K | 32K |
| `cmodel` | Cantus | 1.60x | ✓ | ✓ | 180K | 32K |
| `qmodel_preview` | Qwen3.8-Max-Preview | 0.01x promo | ✓ | ✓ | 180K | 32K |
| `qmodel_38max` | Qwen3.8-Max | 0.25x | ✓ | ✓ | 180K | 32K |
| `qmodel_latest` | Qwen3.7-Max | 0.10x promo | ✓ | ✗ | 1M | 32K |
| `qmodel` | Qwen3.7-Plus | 0.04x promo | ✓ | ✗ | 1M | 32K |
| `kmodel_latest` | Kimi-K3 | 0.80x | ✓ | ✗ | 180K | 32K |
| `kmodel` | Kimi-K2.7-Code | 0.30x | ✓ | ✗ | 256K | 32K |
| `gm51model` | GLM-5.2 | 0.50x promo | ✓ | ✓ | 1M | 32K |
| `dmodel` | DeepSeek-V4-Pro | 0.50x | ✓ | ✓ | 1M | 32K |
| `dfmodel` | DeepSeek-V4-Flash | 0.10x | ✓ | ✓ | 1M | 32K |
| `mmodel` | MiniMax-M3 | 0.20x | ✓ | ✗ | 1M | 32K |

This table is a snapshot, not a hard-coded allowlist. Qoder can vary model
availability by account, plan, CLI version, or staged rollout. Promotional
multipliers are time-dependent; the SDK's current `priceFactor` is
authoritative. Restart OpenCode to refresh the bridge's in-process model cache.

Run `opencode models qoder` to inspect the models currently registered with
OpenCode. The `qoder_models` tool also exposes capabilities, context limits,
and price multipliers to the agent. Model discovery is cached and refreshed in
the background so network or authentication latency does not block startup.

## Configuration

Bridge opencode MCP servers into the SDK by passing provider options:

```json
{
  "provider": {
    "qoder": {
      "options": {
        "extraArgs": { "--experimental-mcp-load": null }
      }
    }
  }
}
```

`config.mcp` servers are bridged into the SDK's `mcpServers` automatically.

### Persistent sessions and permissions

Session persistence is opt-in. Give a provider configuration a stable
`sessionKey` and enable `sessionPersistence`:

```json
{
  "provider": {
    "qoder": {
      "options": {
        "sessionPersistence": true,
        "sessionKey": "my-project-main"
      }
    }
  }
}
```

Mappings are stored in
`~/.config/opencode-qoder-bridge/sessions.json` with restrictive file
permissions. Use the `qoder_session_reset` tool to forget the mapping. A new
session is created automatically if the mapping does not exist; existing
sessions are resumed through the Qoder SDK.

The bridge uses the SDK's safer permission policy by default. To explicitly
allow all Qoder tools in a trusted local environment, configure for example:

```json
{
  "provider": {
    "qoder": {
      "options": {
        "permissionMode": "default",
        "allowedTools": ["Read", "Glob", "Grep"]
      }
    }
  }
}
```

Available permission modes are `default`, `acceptEdits`, and
`bypassPermissions`. Only explicitly configure `bypassPermissions` when the
host environment is trusted.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Auth prompt at startup | Run `qoder login`, then restart opencode |
| `qodercli not found` | Authenticate with `qoder login` or set `QODER_PERSONAL_ACCESS_TOKEN`; the SDK can use its bundled runtime, while an installed CLI is preferred when available |
| Model not found | Verify the model ID matches the table above |
| Missing models in the model list | Run `/qoder_models`; the bridge refreshes the live catalog at every startup and falls back to the last cached catalog plus the built-ins (`lite`, `auto`, `performance`) when offline. If your account serves models in a different Qoder scene, set `QODER_SCENE` before launching opencode (or via provider option `env`) |

### How model discovery works

At startup the bridge immediately exposes cached/built-in models, then
refreshes the live catalog from Qoder (`fetchStrategy: "live"` — the CLI
re-queries the server and falls back to its local cache if the server returns
nothing). Discovered models override built-ins with the same ID; a failed
refresh never removes previously known models.

## Development

```bash
npm install
npm run build      # compile to dist/
npm run typecheck  # type-check only
npm test           # build and run the test suite
npm run test:e2e   # authenticated real-CLI test; requires QODER_E2E=1
npm run check      # full pre-publish verification
```

### Diagnostics

Set `QODER_BRIDGE_DEBUG=1` before launching opencode to emit detailed bridge
logs (model fallbacks, stream aborts, background catalog refreshes, ledger and
session-store I/O failures). Warnings that need attention are always printed.

State files (usage ledger, session mapping, model cache) live under
`~/.config/opencode-qoder-bridge` by default; override with
`QODER_BRIDGE_STATE_DIR`, or relocate via `XDG_CONFIG_HOME`.

The end-to-end test is intentionally opt-in because it starts Qoder and may
consume account quota. Run it only after `qoder login`:

```bash
QODER_E2E=1 npm run test:e2e
```

## Security

Report suspected vulnerabilities privately as described in
[SECURITY.md](./SECURITY.md). Do not include Qoder credentials, npm tokens, or
private prompt content in reports.

Maintainer release instructions are in [RELEASING.md](./RELEASING.md).
Release history is recorded in [CHANGELOG.md](./CHANGELOG.md).

## License

The bridge source is MIT licensed; see [LICENSE](./LICENSE). Dependencies retain
their own licenses and terms; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
