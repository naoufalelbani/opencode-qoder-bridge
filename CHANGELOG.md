# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/).

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
