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

With npm 12, dependency install scripts may be blocked by the consuming
project's script-approval policy. To download SDK `1.0.31`'s bundled Worker
runtime, approve and rebuild it from that project:

```bash
npm install-scripts approve @qoder-ai/qoder-agent-sdk@1.0.31
npm rebuild @qoder-ai/qoder-agent-sdk
```

If you use a separately installed `qoder` CLI or intentionally set
`QODER_SKIP_DOWNLOAD=1`, this step is not required; the bridge can use that
runtime fallback instead.

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

OpenCode loads server plugins and TUI plugins independently. On its first
load, the bridge safely adds its bundled TUI entry to the global
`~/.config/opencode/tui.json`, preserving existing settings. Restart OpenCode
once after initial installation so the TUI loader can activate it. The regular
TUI loads these commands; OpenCode's `--mini` interface does not load external
TUI plugins in current releases. The resulting entry is equivalent to:

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
SDK-version-dependent. A permanent allowlist is intentionally not embedded
here because the catalog is account- and scene-dependent.

There is intentionally no static model table here. Model availability is
account-, region-, plan-, scene-, SDK-version-, and rollout-dependent, and the
SDK's live catalog is authoritative for selectable IDs, capabilities, context
limits, and pricing.

Run `opencode models qoder` to inspect the models currently registered with
OpenCode. The `qoder_models` tool also exposes capabilities, context limits,
and price multipliers to the agent. On each plugin startup, the bridge performs
bounded live discovery automatically; if Qoder is unavailable, it uses the
last catalog for the same credential/deployment context and the built-ins.

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

Flag names may be written with or without the leading `--`.

`config.mcp` servers are bridged into the SDK's `mcpServers` automatically.
Chat turns have a 30-minute bridge timeout by default; set `options.timeoutMs`
to a positive value to use a shorter or longer bounded timeout (up to 24 hours).
Values in `options.env` override inherited process variables rather than
replacing the complete child environment.

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
permissions and are scoped to the configured working directory. The plugin
uses OpenCode's project directory when available; set `options.cwd` when
loading the provider directly. Use the `qoder_session_reset` tool to forget
the mapping. A new session is created automatically if the mapping does not
exist; existing sessions are resumed through the Qoder SDK.

Qoder-native and bridged MCP tools remain provider-owned. If OpenCode supplies
a function with a colliding native name, the bridge derives a Qoder deny rule
to avoid executing the same operation in both runtimes.

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

Image inputs may reference `file://`, `~/`, or absolute local paths. Only pass
paths from trusted callers: the bridge bounds image size but does not sandbox
or restrict readable local files to the project directory. A current turn is
limited to 64 images and 40 MiB of decoded image data; excess attachments are
reported as omitted text.

### Plan Mode

Plan Mode instructs Qoder to analyze and plan changes without modifying files
or running action tools. It operates independently from tool permissions,
preserving your configured `permissionMode`:

```json
{
  "provider": {
    "qoder": {
      "options": {
        "planMode": true
      }
    }
  }
}
```

The plugin automatically registers the following local TUI slash commands in
OpenCode. No manual `opencode.json` edits are required; restart OpenCode after
installing or updating the plugin, then select the command from the `/`
autocomplete list:

The implementations remain registered, but the TUI marks commands as hidden
when their prerequisites are absent; it does not disable or delete them. With
the default configuration, only `/qoder_usage` and `/qoder_models` appear.
Session commands appear when session persistence, `sessionKey`, or `sessionId`
is configured. MCP commands appear when at least one MCP server is configured.
`/qoder_plan_mode` remains hidden because it currently provides guidance only.

| Command | Arguments | Purpose |
|---------|-----------|---------|
| `/qoder_usage` | none | Show live quota and local cost/token totals. |
| `/qoder_models` | none | List available Qoder models and capabilities. |
| `/qoder_sessions` | optional directory and/or limit | List recent Qoder sessions. |
| `/qoder_session_reset` | optional key, or `all` | Reset persisted session mappings. |
| `/qoder_session_fork` | optional session ID, directory, title, cutoff | Create an independent session branch. |
| `/qoder_mcp_status` | none | Inspect MCP connection and OAuth status. |
| `/qoder_mcp_auth` | server, then optional callback URL | Start or complete MCP OAuth. |
| `/qoder_plan_mode` | none | Show Plan Mode status and configuration guidance. |

These commands execute in the TUI and show their result in a modal box. They do
not create an LLM turn or consume model tokens. Commands that accept arguments
open a local input box first. The same names are also registered as tools for
agent use, which is a separate model-driven path.

### Proxy & Network Routing

Pass an outbound proxy URL directly to the Qoder runtime without mutating host
environment variables (supports `http://`, `https://`, `socks5://`, and `socks://`):

```json
{
  "provider": {
    "qoder": {
      "options": {
        "proxy": "http://127.0.0.1:8888"
      }
    }
  }
}
```

If `proxy` is omitted, the bridge automatically falls back to `HTTPS_PROXY` or
`HTTP_PROXY` from your environment.

### Memory

Memory is opt-in. Native mode lets Qoder consume project/user memory and run
turn-completion generation while keeping generated content under Qoder's own
memory controls:

```json
{
  "provider": {
    "qoder": {
      "options": {
        "memory": {
          "mode": "native",
          "projectScope": true,
          "userScope": false
        }
      }
    }
  }
}
```

The bridge waits up to 10 seconds for Qoder's memory/evolution background work
after a successful turn, then closes the query. A slow or failed background
operation is logged in debug mode and does not fail the user turn.

### Security Scan

Security checks are opt-in and disabled unless explicitly configured:

```json
{
  "provider": {
    "qoder": {
      "options": {
        "securityScan": {
          "l1StaticCheck": true,
          "l2LightweightScan": true,
          "l3DeepScan": false
        }
      }
    }
  }
}
```

L1 runs after supported edits; L2/L3 enable repository scans. These checks do
not replace the bridge's permission policy and may consume additional Qoder
credits.

### MCP OAuth and session forks

Use `qoder_mcp_status` to inspect configured server state. For a server with
`needs-auth`, run `qoder_mcp_auth` without `callbackUrl`, open the returned
authorization URL, then run it again with the complete OAuth callback URL.
The bridge keeps the initialized SDK query alive for this two-step flow and
expires it after ten minutes.

Use `qoder_session_fork` to create an independent local transcript branch.
The active provider mapping is intentionally unchanged; continue the returned
session ID explicitly when you want to work on the fork.

### Skill Evolution

Enable autonomous turn-completion skill analysis and recommendations:

```json
{
  "provider": {
    "qoder": {
      "options": {
        "evolution": {
          "skill": { "mode": "native" }
        }
      }
    }
  }
}
```

### Available Tools

The plugin registers several built-in OpenCode tools:

- `qoder_usage` — Live account balance, quota percentages, and local cost ledger totals.
- `qoder_models` — List known Qoder models, context limits, vision/reasoning flags, and multipliers.
- `qoder_sessions` — List recent Qoder sessions, session IDs, branches, and timestamps via SDK `listSessions()`.
- `qoder_session_reset` — Forget the persisted Qoder session mapping for the active project.
- `qoder_session_fork` — Fork a local Qoder transcript without changing the active mapping.
- `qoder_mcp_status` — Show MCP connection, tool-count, and OAuth state.
- `qoder_mcp_auth` — Start or complete active MCP OAuth authentication.
- `qoder_plan_mode` — View Plan Mode status and configuration guidance.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Auth prompt at startup | Run `qoder login`, then restart opencode |
| Qoder runtime unavailable | Authenticate with `qoder login` or set `QODER_PERSONAL_ACCESS_TOKEN`; the bridge uses the SDK's bundled Worker runtime for model discovery and can fall back to an installed CLI automatically |
| Model not found | Run `opencode models qoder` or `/qoder_models`; model IDs are account- and scene-specific |
| Missing models in the model list | Restart OpenCode; the bridge performs a live catalog lookup automatically and falls back to the last scoped catalog plus the built-ins (`lite`, `auto`, `performance`) when offline. If your account serves models in a different Qoder scene, set `QODER_SCENE` before launching OpenCode |

The SDK package `1.0.31` bundles qodercli `1.1.38`. If the bridge discovers a
separately installed qodercli first, update that CLI through its normal Qoder
CLI installer too so the MCP OAuth and oversized-image compaction fixes are
active on that path.

### How model discovery works

At startup the bridge performs a bounded live catalog discovery from Qoder
before returning the provider configuration (`fetchStrategy: "live"` — the
bundled Worker runtime re-queries the server, with an automatic installed-CLI
fallback when necessary). Each successful catalog snapshot replaces
previously discovered dynamic IDs, so retired models do not remain selectable.
A failed, empty, or slow refresh falls back to the last scoped catalog and the
built-ins; no `qodercli --list-models` command or manual model configuration is
required. The startup wait is bounded to 10 seconds, after which OpenCode
continues with the available cache/fallbacks.

## Development

```bash
npm install
npm run build      # compile to dist/
npm run typecheck  # type-check only
npm test           # build and run the test suite
npm run test:stress # deterministic stress suite; live abort stress is opt-in
npm run test:e2e   # authenticated real-CLI test; requires QODER_E2E=1
npm run check      # full pre-publish verification
```

### Diagnostics

Set `QODER_BRIDGE_DEBUG=1` before launching opencode to emit detailed bridge
logs (model fallbacks, stream aborts, live catalog discovery, ledger and
session-store I/O failures). Warnings that need attention are always printed.

State files (usage ledger, session mapping, model cache) live under
`~/.config/opencode-qoder-bridge` by default; override with
`QODER_BRIDGE_STATE_DIR`, or relocate via `XDG_CONFIG_HOME`.

The end-to-end test is intentionally opt-in because it starts Qoder and may
consume account quota. Run it only after `qoder login`:

```bash
QODER_E2E=1 npm run test:e2e
```

To include the live concurrent-abort probe in the stress suite, set
`QODER_STRESS_E2E=1` as well as a valid Qoder credential.

## Security

Report suspected vulnerabilities privately as described in
[SECURITY.md](./SECURITY.md). Do not include Qoder credentials, npm tokens, or
private prompt content in reports.

Maintainer release instructions are in [RELEASING.md](./RELEASING.md).
Release history is recorded in [CHANGELOG.md](./CHANGELOG.md).

## License

The bridge source is MIT licensed; see [LICENSE](./LICENSE). Dependencies retain
their own licenses and terms; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
