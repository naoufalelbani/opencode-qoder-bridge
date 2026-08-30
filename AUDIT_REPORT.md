# Production Audit Report

Date: 2026-08-30

Scope: `opencode-qoder-bridge` source and generated distribution; OpenCode
plugin/config hooks; Qoder Agent SDK integration; streaming, cancellation,
timeouts, sessions, state files, tools/MCP, prompts/images, authentication,
usage/cost/TUI/CLI paths, TypeScript/package boundaries, and release behavior.

This is an evidence-backed audit and hardening record. It does not claim that
all possible defects have been found or fixed.

## Release assessment

**READY WITH KNOWN RISKS** for the documented trusted single-user/local-
workspace use case after the deterministic gates below pass. This is **not an
unconditional publish approval**: the authenticated Qoder E2E gate was
attempted but Qoder rejected the turn because the account reached its credit
limit, and npm authentication is not configured in this environment. The
working release identity is now `0.1.9`; the residual risks below require
maintainer acceptance.

## Audit method and independent agents

The first pass used six independent engineering roles, each reading the
repository and installed SDK contracts before the fixes were integrated:

| Agent | Independent role | Focus |
| --- | --- | --- |
| Avicenna | Architecture/compatibility | model/config/env/session API behavior |
| Poincare | Streaming/async/exceptions | stream protocol, cancellation, cleanup, timeout paths |
| Galileo | Sessions/state/concurrency/performance | persistence, leases, races, long-running behavior |
| Fermat | Tools/MCP/security | tool ownership, MCP conversion, injection and secret boundaries |
| Sartre | Package/release/DRY/TypeScript | exports, runtime dependencies, packaging, maintainability |
| Parfit | Adversarial QA/devil's advocate | fault injection, malformed inputs, invariants and stress |

A second independent council then re-audited the changed tree:

| Agent | Challenge role | Outcome |
| --- | --- | --- |
| Plato | architecture/compatibility challenge | confirmed workspace/explicit-ID/reset fixes after reconciliation |
| Gibbs | streaming/lifecycle challenge | confirmed iterator and cleanup improvements; retained filesystem/transport risks |
| Ampere | session/concurrency challenge | reproduced stale-lease/reset/ledger issues; fixes were applied and re-tested |
| Laplace | tools/security challenge | confirmed denylist/redaction/cap fixes; retained conditional MCP destination risk |
| Arendt | package/release challenge | confirmed package boundary; retained version/E2E publication gates |
| Hubble | final red team | reproduced malformed-stream, session, error-boundary, and liveness defects that drove fixes |

For the high-severity findings, competing fixes were considered and challenged:
workspace-keyed records versus separate state files (workspace-keyed records
preserved the file/API); abort-only versus manual iterator races (manual
`nextWithAbort` plus bounded cleanup); denying all MCP names versus preserving
provider-owned MCP execution (MCP names are excluded from the native denylist);
and atomic last-writer-wins cost writes versus lock-and-merge pending turns (the
latter was implemented). A few agent reports contained line references from a
pre-fix snapshot; final status below is based on the current source, generated
`dist`, and rerun commands.

## Confirmed bugs fixed

- Runtime `tool()` was imported from `@opencode-ai/plugin` while that package
  was dev-only. It is now a production dependency and clean packed imports
  pass.
- Unknown model IDs are forwarded unchanged to Qoder; the fallback catalog is
  used only for conservative prompt limits and no silent remap to `auto` occurs.
- SDK transcript persistence is explicitly false for ordinary and auxiliary
  ephemeral calls; explicit `sessionId` remains an intentional opt-in to the
  SDK's persistent-session behavior.
- Child-process environment options inherit `process.env` and can provide a
  configured PAT; PATH and unrelated host variables are not discarded.
- Session mappings are scoped by `(sessionKey, physical cwd)` using a backward-
  compatible `sessions.json` migration path. Same-session turns serialize in
  process and across processes; explicit session IDs are the effective lease
  identity when supplied.
- Corrupt, oversized, symlinked, unreadable, or partially invalid session
  state is readable where possible but never silently rewritten. Reset-all
  uses an epoch fence so an older in-flight request cannot recreate a mapping;
  named reset uses the same effective lease identity as chat.
- Session leases heartbeat while active and compare device/inode before
  unlinking, preventing an old owner from deleting a replacement lock.
- Query iteration is abort-aware, chat requests have a 30-minute default and
  24-hour maximum, and cleanup is awaited through a bounded grace period.
  `doGenerate` cancels/releases its reader on stream errors and cannot resolve
  a canceled or incomplete stream as a successful empty generation.
- Stream state now rejects malformed block boundaries, invalid indexes, missing
  events/deltas/content/tool JSON, duplicate starts, oversized tool input and
  output, and result messages that leave blocks open. Terminal block closures
  retain start order and finish/error emission is one-shot.
- Native Qoder tool aliases map to the installed SDK's canonical names,
  provider-owned `mcp__...` tools are not added to the native denylist, and
  duplicate tool IDs/replayed payloads cannot produce duplicate host calls.
- SDK errors, result subtypes, raw stop reasons, structured log details, and
  usage CLI errors pass through bounded secret/control redaction.
- Prompt structural tags from untrusted content are escaped; history trimming
  pairs assistant tool calls with their results; text, tool input, metadata,
  artifacts, and current-turn image attachments have explicit bounds.
- MCP conversion now rejects malformed transports, control characters,
  embedded URL credentials, blank commands, oversized collections, and
  sub-second timeouts that the SDK would not honor. Commands remain structured
  spawn arguments, not shell strings.
- Usage/model discovery has host-side promise deadlines and bounded iterator
  cleanup. Cost ledger writes use cross-process locking and merge pending turns
  before atomic replacement, avoiding lost increments.
- State/TUI/ledger/model cache writes use restrictive permissions, atomic
  replacement, temporary-file cleanup, finite-number validation, and
  prototype-safe maps. `prepack` rebuilds `dist`; both CLI binaries are
  executable; `./errors` is an additive public export.

## Exception and failure behavior

- Authentication failures use `QoderAuthError`; SDK result failures use
  `QoderSdkResultError` with stable codes/subtypes. Error parts are emitted
  before the terminal finish and open blocks are closed first.
- A structured invalid-session result clears only the current workspace
  mapping. A thrown/iterator-rejected error whose text identifies an invalid
  resume session also clears that mapping, allowing the next request to start
  fresh. Unrelated transport errors do not delete state speculatively.
- Failed or canceled turns do not persist new session mappings. Cost recording
  deliberately records structured failed results because those attempts may be
  billable.
- External cancellation closes without a later success finish. Completion that
  becomes terminal before a simultaneous abort uses completion-wins semantics;
  this is documented race behavior.
- Controller operations, reader cleanup, and SDK iterator cleanup are
  best-effort and idempotent so host cancellation does not produce unhandled
  teardown exceptions.

## Concurrency and state

- In-process session tails and hashed OS leases cover the actual Qoder turn,
  not only the JSON write. A two-process turn probe serialized the same logical
  session; concurrent disjoint session writes retained every record.
- Workspace reuse of one logical key no longer overwrites another workspace.
  Specific reset deletes only its workspace mapping. Reset-all changes an epoch
  and fences late persistence.
- The cost ledger now uses a lock-and-merge protocol. The regression test runs
  two processes that flush together and verifies two turns, two input tokens,
  and two output tokens.
- TUI registration uses cross-process read-modify-write locking. Model cache
  writes are coalesced within a process and use atomic replacement.

Residual concurrency risks are the local filesystem contract: mtime-based stale
recovery can still be wrong on a paused process, clock-changing or network
filesystem; `qoderQuery.return()` may outlive its five-second cleanup grace;
and a filesystem operation already inside a read/write call is not forcibly
interruptible. These are retained as qualified risks, not hidden as “hard”
guarantees.

## Streaming, async, and long-running behavior

The adapter translates Qoder stream events into AI SDK v3 parts with explicit
state for text, reasoning, tools, result receipt, authentication expiry,
artifacts, plan mode, and finish state. It guards indexes, IDs, JSON inputs,
block starts/stops, event UUID payload replays, usage numbers, metadata depth,
and terminal ordering. The request timer aborts the SDK and the manual async
iterator race prevents a pending `next()` from defeating ordinary cancellation.

The stream still has no true consumer backpressure mechanism: a very fast
producer can enqueue faster than a stalled host consumer. The upstream SDK may
also assign fresh UUIDs to logically replayed frames, which cannot be deduped
without a provider sequence number. Cross-request idempotency for arbitrary
host side effects is not possible without a stable request/tool transaction ID;
the bridge therefore relies on exact upstream tool IDs and Qoder's denylist
contract. These remain accepted risks.

## Tools and MCP

- Host-owned native aliases are mapped against the SDK 1.0.30 canonical set,
  including `WebFetch`, `WebSearch`, `ImageGen`, `ImageSearch`, `NotebookEdit`,
  `Task*`, `TodoWrite`, and `UpdateGoal`.
- Configured `mcp__server__tool` calls remain provider-owned by Qoder and are
  not simultaneously surfaced as host calls. Tool input must be an object,
  must have a bounded serialized size, and must arrive before execution.
- Stdio arguments are passed as separate structured arguments. No shell
  concatenation or direct shell-injection path was found.
- HTTP/SSE URLs are limited to HTTP(S), reject credentials/control characters,
  and headers/collections are bounded. The SDK's public MCP shape does not
  expose an OpenCode OAuth credential field, so OAuth-backed remote MCP remains
  unsupported rather than silently forwarded.

The bridge intentionally permits loopback/private MCP URLs for trusted local
MCP servers. If workspace configuration is untrusted, this is a conditional
SSRF risk and should be addressed with an explicit destination allow/deny
policy before using the bridge as a multi-tenant service. Prefix ownership for
all `mcp__...` names is similarly conservative and can make an unrelated host
tool unreachable.

## Security and privacy

- PAT/API-key/Bearer/key-value/query-string forms are redacted from logs,
  structured error details, usage CLI errors, and exposed raw finish reasons;
  control characters are removed from diagnostic text.
- Session, model, TUI, and ledger state is stored under per-user directories
  with restrictive modes where the platform permits; dangerous keys, symlinks,
  oversized files, non-finite numbers, and untrusted metadata shapes are
  rejected or bounded.
- Prompt tags are escaped to prevent untrusted message text from becoming
  bridge control structure. Image payloads are base64-validated and limited to
  20 MiB each, 64 current-turn images, and 40 MiB aggregate decoded image data.
- Local image paths (`file://`, `~/`, absolute paths) are intentionally not
  sandboxed to the workspace. They can read any file accessible to the host
  process and must only be accepted from trusted callers; this is documented in
  the README.
- Qoder and MCP execution are not sandboxed by this package. Permission bypass
  remains explicit and is appropriate only for trusted environments.

## Compatibility, DRY, and TypeScript

- Existing root, `./provider`, and `./tui` entry points remain. `./errors` is
  additive. Existing model/options/config MCP shapes remain supported, with
  intentional behavior changes documented for unknown model IDs, workspace
  session identity, MCP provider ownership, and explicit session persistence.
- `options.env` merges with inherited variables; `QODER_PERSONAL_ACCESS_TOKEN`
  in that child environment is recognized for chat. Model discovery still uses
  host `QODER_SCENE` intentionally because it is an auxiliary operation.
- Common state-directory, timeout, redaction, finite-number, async-deadline,
  and serialization helpers are shared rather than copied into each boundary.
  Remaining explicit state machines are localized to stream/persistence code
  where their lifecycle distinctions are material.
- `npm run typecheck` passes against the installed SDK and OpenCode/AI SDK
  declarations. Narrow wire-object casts are preceded by runtime shape checks.
  The project still uses `skipLibCheck` and generated declarations/maps, which
  are maintainability choices rather than runtime defects.

## Package and release audit

- `@opencode-ai/plugin` is a production dependency; package exports preserve
  root/provider/TUI paths and add `./errors`.
- `prepack` rebuilds TypeScript output. The packed artifact contains `dist`,
  both binaries, required documentation, and no source/tests/lockfile.
- Both packed binaries retain mode 755. Clean dev-omitted installation and
  root/provider/errors import probes pass. Optional TUI peers are intentionally
  host-provided.
- npm already has `opencode-qoder-bridge@0.1.8` as `latest`. The working tree
  now documents and prepares version `0.1.9`, but it has not been committed,
  tagged, or published.
- The host is Node `24.13.0`, below the declared `^24.15.0` 24.x range, so npm
  reports `EBADENGINE`; the declared Node 22.22.2 path remains supported. npm's
  clean consumer also warned that SDK/native install scripts were not approved;
  normal installation with the allowlist is required for the bundled worker
  runtime.

## Tests and validation performed

Latest deterministic run after the final source/test changes:

| Command/check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | Passed: 140 total, 138 passed, 2 skipped, 0 failed; the Qoder-backed stress probe is now opt-in with `QODER_STRESS_E2E=1` |
| `QODER_E2E=1 npm run test:e2e` | Blocked by upstream Qoder error 118: the authenticated account reached its credit usage limit; no bridge assertion completed |
| `npm audit --audit-level=low` | Passed: 0 vulnerabilities |
| `npm audit --omit=dev --audit-level=low` | Passed: 0 vulnerabilities |
| `git diff --check` | Passed |
| `npm pack --dry-run --json` | Passed for `0.1.9`; latest measured artifact was 89 files, 90,387 bytes compressed / 392,919 bytes unpacked |
| `npm whoami` | Blocked: npm registry returned 401 Unauthorized |
| Fresh `npm install --omit=dev` consumer | Passed; 118 packages, 0 vulnerabilities, root/provider/errors imports, both binaries mode 755 |
| `npm ls --omit=dev --depth=1` | Passed; optional TUI peers were absent as expected in the hostless consumer |
| Two-process session lease probe | Passed; same logical session turns serialized |
| Two-process cost flush regression | Passed; no lost turns |

## Fault injection, stress, and adversarial QA

Covered and passing:

- malformed JSON, invalid session entries, prototype-polluting keys,
  symlink/oversize state inputs, non-finite usage/cost/model values;
- missing stream event/block/delta/index, duplicate starts/stops/results,
  replayed payloads, invalid JSON/scalar tool input, absent tool input,
  incomplete result blocks, raw stop-reason secret leakage, and output/tool
  input limits;
- concurrent session writes, same-session lease contention, reset behavior,
  concurrent TUI registration, coalesced model writes, 200 rapid cost turns,
  1,000-message prompt processing, 10 concurrent aborted streams, and
  cross-process cost/session probes;
- malformed MCP transports, embedded URL credentials, control-character
  headers, oversized collections, timeout bounds, command argument handling,
  prompt structural-tag injection, malformed base64, 64-image aggregate
  limiting, package exports, clean installation, and executable modes.

Not performed or not fully validated:

- no authenticated Qoder CLI/Worker turn, real auth-expiry callback, real
  Qoder tool side-effect counter, live MCP stdio/HTTP/SSE server, or real
  cancellation/transport crash was available;
- no Windows, Bun, network-filesystem, ENOSPC, permission-denied, clock-jump,
  or multi-account shared-state integration run was performed;
- no formal consumer backpressure benchmark or cross-request idempotency
  protocol exists because the upstream contract does not provide a stable
  transaction key.

## Findings rejected or disputed after debate

These findings remain recorded rather than deleted, but were rejected as bugs
in the current implementation or disputed as compatibility requirements:

- **AGENT-001 initial capacity limitation — REJECTED as current process state.**
  An initial spawn attempt hit the agent-thread limit, but six first-pass and
  six second-pass independent agents subsequently returned; the process
  limitation is not used to hide the council evidence.
- **GIBBS-DECL-001 stale declaration-order blocker — REJECTED.** The report
  read a pre-fix snapshot; current `npm run typecheck` passes and the declaration
  order is correct.
- **PROMPT-003 truncation-marker escaping failure — REJECTED.** The observed
  test mismatch came from treating the generated marker as untrusted text; the
  marker is generated by the bridge and the regression now passes.
- **MCP-003 direct shell injection — REJECTED.** SDK inspection and structured
  spawn probes found no shell concatenation; command fields remain separate.
- **TOOL-002 duplicate execution in tested replay paths — REJECTED.** Repeated
  IDs, replayed payloads, stream/assistant fallback, and MCP/native collisions
  produced no duplicate host tool call in the current tests. Upstream permission
  regressions and fresh-UUID replay remain residual risks, not reproduced bugs.
- **MODEL-002 silent unknown-model remap — FIXED, not rejected.** The original
  behavior was a confirmed compatibility bug; forwarding and regression coverage
  now preserve the requested ID.
- **PKG-002 missing runtime dependency, REL-001 stale dist/prepack, and
  BIN-001 non-executable usage binary — FIXED/VERIFIED.** Clean packed-consumer
  and mode checks pass.

## Audit finding ledger

Every material finding retains its discovering reviewer, evidence, challenge
result, disposition, regression coverage, and remaining compatibility risk.

| ID | Discovering agent | Component | Severity / confidence | Evidence or reproduction | Challenge result | Status | Chosen fix | Regression test | Compatibility / remaining risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CFG-001 | Avicenna | extra CLI flags | MEDIUM / high | SDK prepends `--`; documented options could double-prefix | Poincare/Plato agreed normalization was needed | VERIFIED | Strip one leading `--` before SDK forwarding | bridge options test | Unusual `---`/reserved flags remain caller responsibility |
| ENV-001 | Avicenna | child environment | HIGH / high | Replacing env could remove PATH/runtime variables | Plato confirmed merge behavior | VERIFIED | Merge configured env over `process.env`; recognize child PAT | inherited env test | Child env remains trusted input |
| MOD-001 | Avicenna | model selection | HIGH / high | Unknown ID previously selected `auto` silently | Plato confirmed requested-ID forwarding | VERIFIED | Forward requested ID; fallback only for prompt sizing | unknown model test | Offline catalog may make valid account IDs look unknown until Qoder responds |
| SES-001 | Galileo/Hubble | session state identity | HIGH / high | Same key in two workspaces overwrote the first mapping | Plato/Ampere confirmed scoped records and reset behavior | VERIFIED | Hash cwd into backward-compatible scoped state keys; realpath cwd | workspace isolation + concurrent tests | Shared account/state directory remains an operator trust assumption |
| SES-002 | Galileo | turn concurrency | HIGH / high | JSON locking alone did not serialize the SDK turn | Ampere confirmed cross-process lease need | VERIFIED | Hashed per-session OS lease plus in-process tail | session lease stress/two-process probe | Stale/paused/network-FS lock policy remains conditional |
| SES-003 | Galileo | reset operations | MEDIUM / high | reset-all could be undone by a finishing turn; named reset could use a different lease identity | Plato challenge identified explicit-ID named-reset race; patched effective lease key and epoch fence | VERIFIED | reset epoch for all; explicit session ID lease for named reset | reset/session tests; typecheck/full suite | A filesystem call already in progress cannot be forcibly canceled |
| SES-004 | Avicenna | SDK persistence | HIGH / high | SDK default persistence could write transcripts for ephemeral requests | Independent architecture passes agreed | VERIFIED | Explicit `persistSession` for all bridge/auxiliary calls | persistence option test | Explicit `sessionId` intentionally enables persistence |
| SES-005 | Hubble | invalid resume recovery | HIGH / medium | thrown query/iterator invalid-session errors left stale mapping | Current catch classifies invalid-session transport text and deletes only cwd mapping | VERIFIED | Delete current mapping on structured or identifiable invalid resume failure | session store and failure-path coverage | Unstructured upstream errors may not include a recognizable session marker |
| STR-001 | Poincare/Hubble | stream terminal state | HIGH / high | duplicate result/tool events and late frames could emit multiple terminal parts | Parfit red-team replay probes pass | VERIFIED | bounded payload replay IDs, tool IDs, one-shot finish | duplicate/replay/late-result tests | Fresh upstream UUID replays cannot be proven idempotent without sequence numbers |
| STR-002 | Poincare | cancellation/liveness | HIGH / high | abort could resolve `doGenerate` as empty success; `for await` could wait on pending `next()` | Gibbs confirmed manual iterator and reader cleanup changes | VERIFIED | `nextWithAbort`, `sawFinish`, AbortError, bounded query cleanup | abort stress and reader-cancel tests | Non-cooperative SDK process may outlive the five-second cleanup grace |
| STR-003 | Hubble | malformed stream protocol | HIGH / high | missing block/delta/stop/input previously failed open and could reach success/tool `{}` | Gibbs/Laplace challenge confirms fail-closed boundary tests | VERIFIED | Reject malformed boundaries, missing tool JSON, duplicate starts, unknown block shapes | malformed boundary/tool tests | Unknown valid SDK top-level messages remain ignored for compatibility |
| STR-004 | Gibbs | block ordering | MEDIUM / high | category-based closure could reorder interleaved open blocks | Current order regression passes | VERIFIED | Track open blocks in start order and close that sequence | open-block ordering test | No consumer backpressure is implemented |
| STR-005 | Laplace/Gibbs | payload bounds | MEDIUM / high | partial tool input, output, metadata, artifacts, and images could grow without total bounds | Challenge confirmed current caps; initial/fallback paths were added and re-tested | VERIFIED | 4 MB tool input, 8 MB output, bounded metadata/artifacts, 64/40 MiB images | stress and metadata/image tests | Prompt token budget remains heuristic |
| TOOL-001 | Fermat/Plato/Laplace | native/MCP ownership | HIGH / high | incomplete canonical denylist and MCP collision could enable double ownership | Laplace confirms expanded map and provider-owned MCP filter | VERIFIED | Canonical aliases; exclude provider-owned `mcp__` from native denylist | tool-deny/MCP collision tests | Prefix ownership can hide an unrelated host `mcp__` function |
| MCP-001 | Fermat | remote MCP auth | MEDIUM / high | SDK public MCP config has no safe OpenCode OAuth field | Laplace confirms no supported pass-through | ACCEPTED RISK | Do not silently forward unsupported credentials | MCP conversion tests | OAuth-backed remote MCP needs a future SDK-supported adapter |
| MCP-002 | Laplace | MCP destination policy | MEDIUM / high | loopback/private/metadata URLs remain accepted for local servers | Challenge classifies as conditional SSRF under untrusted config | ACCEPTED RISK | Preserve trusted local MCP compatibility; document boundary | URL/credential/control tests | Add allow/deny policy before multi-tenant use |
| PROMPT-001 | Avicenna | history trimming | MEDIUM / high | assistant tool call could be retained without its result | Debate favored atomic tool-call/result groups | VERIFIED | O(n) paired message groups | continuation trimming test | Unmatched historical tool messages are still represented conservatively |
| PROMPT-002 | Fermat/Laplace | local images | MEDIUM / high | arbitrary readable path can be converted to base64 | Challenge confirms intentional trusted-caller policy | ACCEPTED RISK | Per-image/aggregate limits and explicit README warning | image bounds/stress tests | No workspace sandbox or symlink race defense |
| SEC-001 | Fermat/Hubble/Laplace | secrets/errors/logs | HIGH / high | JSON details, SDK errors, raw subtypes, and usage CLI could bypass redaction | Laplace confirms current redaction/control tests | VERIFIED | Recursive log serialization, redacted typed errors and public errors | redaction/error tests | Unknown future logger sinks must retain `safeLogDetail` use |
| SEC-002 | Laplace | metadata/state | MEDIUM / high | unbounded metadata/path fields could pressure IPC/UI or disclose paths | Current node/string/artifact caps reduce exposure | VERIFIED | bounded `toJsonValue`, artifact cap, finite/prototype checks | metadata stress tests | Artifact/path content is still visible to the trusted host |
| USG-001 | Poincare | usage/model discovery | MEDIUM / high | auxiliary SDK promises and cleanup were not host-deadline bounded | Current `withTimeout`/bounded iterator cleanup passes | VERIFIED | shared async deadline/cleanup helpers | usage and model tests | Live transport behavior remains unverified |
| LED-001 | Galileo | cost ledger | MEDIUM / high | two atomic last-writer-wins processes lost one increment | Ampere reproduced; lock-and-merge regression passes | VERIFIED | cross-process lock and pending-entry merge | two-process cost test | Ledger lock still depends on local filesystem semantics |
| CAT-001 | Galileo | dynamic model cache | MEDIUM / high | cache is process/state-dir global, not account/scene keyed | Council retained as product/isolation policy risk | ACCEPTED RISK | Keep stable cache behavior; future account/scene key | snapshot replacement/cache tests | Shared accounts/scenes can see stale catalog data |
| PKG-001 | Sartre/Arendt | runtime package boundary | HIGH / high | dev-omitted install could not load runtime plugin helper | Arendt clean consumer imports pass | VERIFIED | Move plugin helper to production dependencies | pack/import checks | Adds required runtime dependency |
| REL-001 | Sartre/Arendt | generated release artifact | HIGH / high | stale/missing dist and prepack omissions were possible | Arendt confirms 89-file packed artifact and dist parity | VERIFIED | `prepack: npm run build`; required exports/files checked | pack dry-run/consumer checks | Release still requires version bump |
| COMP-001 | Sartre/Arendt | runtime engines/peers | MEDIUM / high | host Node 24.13 emits engine warning; TUI peers absent in clean server consumer | Package remains compatible with declared supported Node/host model | ACCEPTED RISK | Retain declared range and optional peer contract | clean install/npm ls | Run release CI on Node 22.22.2 or Node 24.15+ |
| E2E-001 | Parfit/Hubble/Arendt | credentialed integration | HIGH / certain limitation | `QODER_E2E=1` was attempted, but Qoder returned error 118 because the account reached its credit usage limit | Live upstream behavior remains unverified; the failure is external to the bridge | UNRESOLVED RISK | Re-run the authenticated release gate after credits are available | `QODER_E2E=1 npm run test:e2e` | Actual upstream streaming/auth/tool/model behavior remains unverified |
| LIFE-001 | Gibbs | persistence/teardown liveness | MEDIUM / medium | a stalled filesystem call or non-cooperative SDK return can outlive host deadline | Challenge retained as transport/filesystem residual | ACCEPTED RISK | Bounded SDK cleanup and documented local-FS assumptions | abort/cleanup tests | A truly hard kill requires process/SDK support outside this package |
| BP-001 | Gibbs | stream backpressure | MEDIUM / medium | `ReadableStream` enqueue path has no producer throttling | Not safely fixable without changing SDK/host stream contract | ACCEPTED RISK | Keep safe enqueue and bounded payloads | slow/large stress coverage is partial | Very slow consumers can accumulate queued parts |
| IDEM-001 | Fermat/Parfit | side-effect idempotency | HIGH / medium | arbitrary host tools cannot be safely retried/deduped across requests without transaction IDs | No duplicate found in exact-ID probes; upstream contract gap remains | ACCEPTED RISK | Exact tool-ID/replay protections and deny ownership | duplicate tool tests | Host integrations needing stronger guarantees must supply idempotency |
| REL-002 | Arendt | publish identity | MEDIUM / certain | npm already serves `0.1.8`; a release must use a new documented version and matching tag | Local version/changelog preparation now uses `0.1.9`; publish remains unauthenticated | FIXED | Bump/document `0.1.9`; commit/tag before publishing | package version/pack inspection | Do not publish until npm auth and release tag/commit are ready |

## Remaining and unresolved risks

1. Run `QODER_E2E=1 npm run test:e2e` with a real Qoder login/PAT, then exercise
   a real worker/CLI turn, auth expiry, tool call, provider metadata, model
   discovery, session resume/recovery, cancellation, and MCP server.
2. A non-cooperative SDK process or stalled filesystem operation can outlive
   the bridge's timeout/cleanup grace. The bridge can stop waiting, but cannot
   forcibly terminate an external process from a promise boundary.
3. Readable-stream backpressure and fresh-UUID upstream replay semantics remain
   contract-dependent. Cross-request host-tool idempotency is not invented.
4. Model caches are global to the selected state directory rather than keyed by
   account/scene. Use separate state directories for simultaneous accounts or
   implement an account-aware cache policy.
5. Local image paths are a trusted-caller capability and can read outside the
   project; remote MCP URLs permit private destinations for legitimate local
   servers. Do not expose this configuration surface to untrusted tenants.
6. MCP OAuth is unsupported through the current public SDK shape, and prefix
   ownership reserves all `mcp__...` host names.
7. Release `0.1.9` must be committed/tagged after the live gate and npm
   authentication are available. Release CI should use a declared Node engine.
   Clean installs must approve the SDK/native install
   scripts when the bundled worker is required.

## Assumptions

- The package runs under a declared Node engine with a writable per-user state
  directory and local filesystem semantics suitable for lock files.
- One state directory represents one trusted user/account. Session keys are
  stable logical conversation names; workspace identity is the physical cwd.
- The installed contracts remain `@qoder-ai/qoder-agent-sdk@1.0.30`,
  `@opencode-ai/plugin@1.18.19`, and the AI SDK provider declarations used by
  this tree.
- OpenCode supplies optional TUI peer packages when the TUI entry point is
  loaded. Qoder, MCP servers, and permitted host tools are trusted executors.

## Final decision

**READY WITH KNOWN RISKS** for qualified local/trusted use. The deterministic
hardening and package checks pass, and the previously reproduced high-severity
bugs are fixed with regression coverage. Do not publish `0.1.9` until Qoder
credits permit a passing authenticated E2E run, npm authentication is restored,
and the release commit/tag is created; retain the unresolved/accepted risks
above in release notes.
