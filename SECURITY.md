# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting for this repository:

https://github.com/naoufalelbani/opencode-qoder-bridge/security/advisories/new

Include the affected version, reproduction steps, impact, and any suggested
mitigation. You should receive an acknowledgement within seven days.

## Supported versions

Security fixes are provided for the latest published version. Users should also
keep OpenCode, the Qoder CLI, and package dependencies current.

## Credential handling

This plugin does not distribute Qoder credentials. Authentication remains with
the Qoder Agent SDK. Use a personal access token or local Qoder sign-in as
documented by the SDK; its bundled Worker runtime can be used without a
separately installed Qoder CLI. Never include files from `~/.qoder/`, npm
tokens, prompts containing secrets, or local usage ledgers in a report.
