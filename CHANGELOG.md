# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/).

## [0.1.11] - 2026-09-01

### Added

- Automatically registers `/qoder_usage`, `/qoder_models`, `/qoder_sessions`,
  `/qoder_session_reset`, `/qoder_session_fork`, `/qoder_mcp_status`,
  `/qoder_mcp_auth`, and `/qoder_plan_mode` as local OpenCode TUI commands
  without requiring manual `opencode.json` or `tui.json` edits.
- Displays command results in local modal boxes without creating an LLM turn or
  consuming model tokens; the matching tools remain available for agent use.
- Updated `@qoder-ai/qoder-agent-sdk` to `1.0.31`, paired with qodercli
  `1.1.38`.
- Added opt-in SDK-native `memory` and `securityScan` provider options.
- Flushes configured memory and skill-evolution background work after
  successful turns with a bounded, non-fatal wait.
- Added `qoder_mcp_status` and `qoder_mcp_auth` tools for MCP health checks and
  Qoder's active OAuth flow.
- Added `qoder_session_fork` for independent local transcript branches.

### Changed

- The bridge package version is `0.1.11`.

## [0.1.10] - 2026-08-30

### Changed

- Model discovery now completes a bounded live Qoder catalog lookup during
  plugin startup, so newly available account models are registered
  automatically without a manual model list or cache warm-up restart.
- Discovery uses the SDK's bundled Worker runtime first, falls back to an
  installed CLI automatically when needed, scopes caches by deployment and
  credential context, and ignores empty or late responses that could otherwise
  replace a known-good catalog.

## [0.1.9] - 2026-08-30

### Added

- Updated `@qoder-ai/qoder-agent-sdk` to `1.0.30` (paired with `qodercli` 1.1.35).
- **Plan Mode Integration**: Added `planMode?: boolean` provider option to run in planning mode independently from tool permissions. Registered new `/qoder_plan_mode` tool.
- **Outbound Proxy Routing**: Added `proxy?: string` provider option for direct qodercli HTTP/HTTPS/SOCKS5 proxy routing without mutating environment variables, with automatic fallback to `HTTPS_PROXY` / `HTTP_PROXY`.
- **Skill Evolution**: Added `evolution?: EvolutionOptions` provider option to enable autonomous turn-completion skill analysis and recommendations.
- **Dynamic Live Model Catalog Updates**: Ingests real-time `available_models_update` stream events to synchronize model availability and persistent cache without restarting OpenCode.
- **Artifacts Tracking**: Ingests `artifacts_update` events during chat turns and surfaces artifact change metadata in `providerMetadata.qoder.artifacts`.
- **Sessions Tool**: Added `qoder_sessions` tool using SDK's `listSessions()` to inspect recent sessions, titles, and git branches.

### Fixed

- **Runtime Package Boundary**: Moved the runtime-used `@opencode-ai/plugin`
  helper into production dependencies and verified root/provider imports from a
  dev-omitted packed install.
- **Workspace-Aware Session Safety**: Scoped persisted session mappings by
  workspace, serialized same-key turns, delayed mapping writes until a
  successful turn, and added bounded cross-process state locking.
- **Catalog, Usage, and Stream Hardening**: Made live model snapshots
  authoritative, bounded discovery/usage requests, closed abort and duplicate
  event races, sanitized malformed SDK usage/metadata, and surfaced typed
  authentication/result failures.
- **Persistent State and Input Bounds**: Hardened atomic state/config writes,
  model/session cache validation, prompt/image limits, MCP URL/command input,
  and finite cost/statusline accounting.
- **Unknown Model Transparency**: Unknown requested model IDs are now forwarded
  unchanged to Qoder while the default catalog entry is used only for prompt
  sizing metadata; the bridge no longer silently selects `auto`.
- **Ephemeral Session Privacy**: Explicitly disables SDK transcript persistence
  for non-persistent turns and auxiliary usage/model discovery queries.
- **Stream and Boundary Hardening**: Added bounded turn timeouts, abort-aware
  generation failures, bounded query cleanup, malformed-stream rejection,
  replay UUID guards, tool ownership deny rules, diagnostic redaction, and
  stricter MCP URL/command validation.
- **Release Artifact Safety**: Added a `prepack` rebuild hook, executable usage
  CLI permissions, and a public `./errors` export for the typed error API.
- **Session Store Concurrency Race Condition**: Added an async mutex queue (`withLock`) to serialize concurrent `ensureQoderSession` and `deleteQoderSession` operations, preventing dropped session records under parallel turns.
- **Tool Continuation History Trimming**: Fixed a critical bug in `trimToBudget` where the active user prompt was dropped during continuation turns with large assistant/tool outputs, preventing prompts from falling back to `"Hello"`.
- **Data URL Parsing Hardening**: Added bounded-length and round-trip base64 validation with early rejection of oversized image attachments, preventing avoidable CPU and memory pressure from malformed multi-megabyte inputs.
- **Stream Controller Abort Safety & Listener Cleanup**: Added `safeEnqueue` and `safeClose` to prevent uncaught `Invalid state: Controller is already closed` exceptions when streams are aborted or cancelled, and cleaned up `abortSignal` event listeners in `language-model.ts` and `sdk-session.ts` to prevent memory leaks on shared signals.
- **`doGenerate` Provider Metadata**: Fixed `doGenerate` discarding `providerMetadata` (`totalCostUSD`, `contextUsageRatio`, `planMode`, `artifacts`), ensuring parity with `doStream`.
- **Coalesced Model Cache Writes**: Implemented a coalesced cache write queue in `models.ts` to prevent simultaneous file write contention and eliminate orphaned `.tmp` files under rapid streaming catalog updates.
- **Atomic File Cleanup & All-Session Reset**: Added `try...finally` temporary file unlinking in `session-store.ts` and `models.ts` to guarantee zero dangling `.tmp` files, and exported `clearAllSessions()` to support full session resets.
- **Tool Schema & Error Boundaries**: Upgraded plugin tools with `tool()` and `tool.schema` from `@opencode-ai/plugin`, added `key` (and `"all"`) to `qoder_session_reset`, added `dir` and `limit` filtering to `qoder_sessions`, and wrapped tool executions in error boundaries.
- **Tool Normalization & Path Aliases**: Added `execute_command`, `executecommand`, `run_command`, and `runcommand` mapping to `bash`, added `cmd` alias for command, and added `path` alias for `filePath` across read, write, edit, delete, view, and apply_diff.
- **MCP Bridge Argument Flexibility**: Converted numeric and boolean arguments in `mcp-bridge` stdio configs without dropping the argument list.
- **Prompt Serialization Hardening**: Added non-image file attachment serialization in `prompt-builder` so attached text files are preserved, and safely guarded missing `toolCallId` / `toolName`.
- **TUI & CLI Hardening**: Guarded `latest.model?.providerID` in `tui.ts` against undefined model objects, guarded against non-finite costs (`NaN`) in sidebar and statusline, and trimmed PAT whitespace in `hasQoderPAT()`.
- **Stress Test Suite**: Added `test/stress.test.mjs` verifying concurrency, massive conversations (1,000 messages), stream aborts, and prototype pollution protection.
- **CI-Safe Live Stress Coverage**: Made the Qoder-backed stream-abort stress probe opt-in with `QODER_STRESS_E2E=1`, keeping the normal test suite credential-free while preserving live stress coverage when explicitly enabled.

## [0.1.8] - 2026-08-26

### Fixed

- Allow authenticated sessions to use the Qoder Agent SDK's bundled Worker
  runtime when a separately installed `qodercli` executable is unavailable.
- Updated authentication and usage guidance to distinguish missing credentials
  from an optional local CLI installation.

## [0.1.5] - 2026-08-22

### Fixed

- Model discovery now requests the live catalog (`fetchStrategy: "live"`).
  The previous `"cache"` strategy could serve an empty or stale subset of the
  account's models, which is why not all available Qoder models were detected.
  The CLI re-queries the server on every refresh and falls back to its local
  cache only when the server returns nothing.

### Added

- `QODER_SCENE` set in the host environment is forwarded to the catalog
  discovery session, and a new provider option `env` passes arbitrary
  environment variables to the qodercli child process for chat turns.
- Debug logging for discovery: usable/total entry counts and discovered model
  IDs are emitted under `QODER_BRIDGE_DEBUG=1`.
- Documentation for model discovery behavior and scene filtering in the
  README troubleshooting section.

### Changed

- Catalog selection drops only disabled or malformed entries; BYOK and
  tagged entries are kept so the bridge never hides a model the server
  actually serves.

## [0.1.4] - 2026-08-22

### Fixed

- Removed an accidental self-dependency (`opencode-qoder-bridge`) from
  `dependencies`, which made npm install a nested copy of the package into
  itself.
- Provider metadata on stream finish is no longer double-nested; consumers now
  read `providerMetadata.qoder.totalCostUSD`, `contextUsageRatio`, and
  `usageEstimated` at the documented path.
- `doGenerate` no longer drops tool-call content parts, so non-streaming
  callers receive tool invocations.
- History trimming in the prompt builder serializes each message once instead
  of re-serializing the whole prompt per dropped turn (O(n²) → O(n)).
- The usage ledger flushes synchronously on process exit, so the most recent
  turns are no longer lost when opencode shuts down inside the debounce window.

### Added

- Typed error hierarchy exported from `dist/errors.js`: `QoderBridgeError`
  base with a stable `code`, plus `QoderCliNotFoundError`,
  `QoderAuthError`, `QoderSessionError`, `QoderSdkResultError`, and
  `UnsupportedCapabilityError`.
- Opt-in debug logging via `QODER_BRIDGE_DEBUG=1` covering model fallbacks,
  stream aborts, background catalog refreshes, and ledger/session-store I/O
  failures that were previously swallowed silently.
- Authorization failures now explain what is missing (CLI vs personal access
  token) instead of returning an unlabeled failure.
- `QODER_BRIDGE_STATE_DIR` and `XDG_CONFIG_HOME` are now honored consistently
  by every state file, including `usage.json`, `sessions.json`,
  `models.json`, and the statusline binary (previously only the session store).
- Diagnostics section in the README.

### Changed

- Model catalog fetches de-duplicate concurrent refreshes into a single SDK
  session.
- The `models.json` cache is written atomically with mode 0600 instead of a
  direct partial-write-prone write.
- Unknown model IDs previously fell back to the default model with a debug log
  entry; current releases preserve the requested ID and let Qoder report model
  availability explicitly.

## [0.1.3] - 2026-08-20

### Changed

- Refreshed the fallback model catalog and quota reporting behavior.
- Removed the experimental model-backed quota command; account usage remains
  available through the `qoder_usage` tool.
- Documentation updates for models and quota handling.

## [0.1.2] - 2026-08-20

### Security

- Changed the default Qoder permission mode from `bypassPermissions` to the
  SDK's safer `default` mode.
- Updated transitive MCP, URL, and glob dependencies; `npm audit` is clean.
- Added atomic, mode-restricted persistent session storage.

### Added

- Opt-in Qoder session persistence and resume support.
- `qoder_session_reset` for clearing a configured persisted session.
- Authenticated opt-in end-to-end testing with `QODER_E2E=1`.
- Deterministic session-store and SDK option-policy tests.
- Direct `QODER_PERSONAL_ACCESS_TOKEN` authentication with CLI fallback.
- Cached, background-refreshed model discovery and `/qoder-models` inspection.

## [0.1.1] - 2026-07-25

### Security

- Removed OpenTUI and Solid from the production dependency graph. The optional
  sidebar now uses the renderer versions supplied by its OpenCode host, which
  prevents OpenTUI's vulnerable build-only Babel and glob packages from being
  installed with this package.
- Pinned patched Babel, glob, minimatch, brace-expansion, and Hono releases for
  repository development and direct root installations.
- Added a zero-tolerance `npm audit` command to the prepublish verification
  gate.

The official Qoder Agent SDK still declares MCP SDK `^1.27.1`. npm does not
propagate a dependency package's overrides into a consuming application's
installation, so a downstream audit can continue to report the MCP SDK's
Windows-only Hono server advisory until Qoder updates that dependency. This
bridge does not start or expose the affected Hono HTTP server; MCP connections
are passed to the Qoder CLI. The Hono 2 override used in this repository was
also verified with an in-process MCP transport.

### Changed

- Moved the type-only AI SDK and OpenCode plugin packages out of production
  dependencies and made the host-provided TUI runtime optional peers.
- Raised the Node.js requirement to 22.18 because the patched Babel toolchain
  no longer supports older Node releases.
- Refreshed model context limits from the live Qoder SDK catalog.

## [0.1.0] - 2026-07-25

### Added

- Initial public release.
- Dynamic Qoder model discovery through the official Agent SDK.
- AI SDK v3 streaming, reasoning, image input, and tool-call translation.
- OpenCode MCP bridging for stdio, HTTP, SSE, and in-process SDK servers.
- Live quota reporting, local usage and cost tracking, CLI commands, and the
  OpenCode TUI sidebar.
- Automated tests, CI, security policy, and trusted-publishing workflow.

[0.1.1]: https://github.com/naoufalelbani/opencode-qoder-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/naoufalelbani/opencode-qoder-bridge/releases/tag/v0.1.0
[0.1.2]: https://github.com/naoufalelbani/opencode-qoder-bridge/compare/v0.1.1...v0.1.2
[0.1.3]: https://github.com/naoufalelbani/opencode-qoder-bridge/compare/v0.1.2...v0.1.3
[0.1.4]: https://github.com/naoufalelbani/opencode-qoder-bridge/compare/v0.1.3...v0.1.4
[0.1.5]: https://github.com/naoufalelbani/opencode-qoder-bridge/compare/v0.1.4...v0.1.5
[0.1.8]: https://github.com/naoufalelbani/opencode-qoder-bridge/compare/v0.1.7...v0.1.8
[0.1.9]: https://github.com/naoufalelbani/opencode-qoder-bridge/compare/v0.1.8...v0.1.9
[0.1.10]: https://github.com/naoufalelbani/opencode-qoder-bridge/compare/v0.1.9...v0.1.10
[0.1.11]: https://github.com/naoufalelbani/opencode-qoder-bridge/compare/v0.1.10...v0.1.11
