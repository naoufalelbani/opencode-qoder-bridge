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

## Prerequisites

1. Use Node.js 22.18 or newer.

2. Install and log in to the Qoder CLI:

   ```bash
   qoder login
   ```

   Credentials are stored under `~/.qoder/.auth/user`.

3. Install opencode:

   ```bash
   npm install -g opencode-ai
   ```

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

Run `/qoder-usage` in OpenCode (it uses the free `qoder/lite` model), run
`qoder-usage` in a terminal for the same live report, or add the statusline
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
`getAvailableModels()` API. The following is the complete enabled catalog
returned by a live query on **2026-07-25**:

| Model ID | Name | Credit multiplier | Vision | Reasoning | Max input | Max output |
|----------|------|-------------------|--------|-----------|-----------|------------|
| `auto` | Auto | 1.00x | ✓ | ✗ | 180K | 32K |
| `ultimate` | Ultimate | 0.80x | ✓ | ✓ | 1M | 32K |
| `performance` | Performance | 1.10x | ✓ | ✗ | 1M | 32K |
| `efficient` | Efficient | 0.30x | ✓ | ✗ | 180K | 32K |
| `lite` | Lite | 0.00x | ✗ | ✗ | 180K | 32K |
| `cmodel` | Cantus | 1.60x | ✓ | ✓ | 180K | 32K |
| `qmodel_preview` | Qwen3.8-Max-Preview | 0.01x promo | ✓ | ✓ | 180K | 32K |
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

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Auth prompt at startup | Run `qoder login`, then restart opencode |
| `qodercli not found` | Install the Qoder CLI; ensure `qodercli` is on PATH or under `~/.qoder/` |
| Model not found | Verify the model ID matches the table above |

## Development

```bash
npm install
npm run build      # compile to dist/
npm run typecheck  # type-check only
npm test           # build and run the test suite
npm run check      # full pre-publish verification
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
