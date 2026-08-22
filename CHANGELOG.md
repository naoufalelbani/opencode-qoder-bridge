# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/).

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
- Unknown model IDs fall back to the default model with a debug log entry.

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
