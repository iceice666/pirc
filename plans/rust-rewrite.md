# Rust rewrite of the server executables

Status: M0 done 2026-10-10; M1 next. Each milestone needs the user's go-ahead before implementation, and the gates marked **Gate** need an explicit decision recorded here before work continues past them.

Paths are relative to `apps/gateway/src/` unless noted.

## Decisions taken with the user (2026-10-10)

- **Goal: smaller executables by removing Bun.** Today `pirc-gateway` is 87 MB and `pirc-chat`/`pirc-node` are 101 MB each (`bun build --compile`, 0.3.0). Success is measured in shipped bytes, so the end state embeds **no JS runtime** (Bun, Node, Deno or V8). A JS sidecar may be used during development to unblock testing, but it is never shipped.
- **Scope: all three roles** (`pirc-gateway`, `pirc-chat`, `pirc-node`), including the agent subprocess, `ptc-guest`, the sandbox and the browser driver.
- **No in-place upgrade.** The Rust release may start from a fresh state directory: no reading of the TS `gateway.sqlite`, node `sessions/*/session.jsonl`, `backends/settings.json` or `vapid.json`. Users re-pair devices, re-login subscription backends and start new sessions. This is a breaking release with migration notes.
- **Location: `crates/`** in this repository, as a Cargo workspace next to `apps/`.
- **One executable for the node and chat roles.** The Rust release ships `pirc-gateway` and `pirc-node`; `pirc-chat` is merged into `pirc-node`. How the role is selected is decided before M6.
- **The test harness is Rust.** Conformance tests drive executables as black boxes from `crates/pirc-conformance`; they run against the TS build first, then against the Rust build.
- **Node protocol bump at cutover.** `NODE_PROTOCOL_VERSION` becomes 10 in the Rust release, so a TS node and a Rust gateway (or the reverse) refuse each other instead of mixing.

## Constraints that stay

- **Port, do not redesign.** The reverted gateway-runtime candidate (`8df69e2`; see the M5 record in `2f0a924`: task time failed in all 52 cohorts) changed architecture and language-independent behavior at once. This rewrite keeps the process model and behavior: the gateway never runs agents or tools; each session's agent is a sandboxed subprocess of its node, speaking JSONL RPC; inference goes through the gateway.
- **The web and Android clients are unchanged.** The client contract (REST, `/api/events` and other WebSockets, error shape, close codes, auth/pairing) must be preserved byte-for-byte where clients depend on it. `fixtures/timeline/*` must pass unchanged.
- **Security model is unchanged** (README "Security model"): trusted-proxy peers, Host/Origin allowlists, forward-auth identity, device tokens, per-node secrets, mandatory OS sandbox, allowlisted environments, secret-safe errors.
- Prompts (`agent/prompts/**`, memory prompts, `SUMMARY_PROMPT`) are reused verbatim (`include_str!`), so model-visible text does not drift.
- Two executables (`pirc-gateway`, `pirc-node`) share library crates; each links only what its role needs.
- Every milestone from M2 on starts by adding conformance scenarios for its area, recorded against the TS build, before porting it.

## Inventory and replacements

| TS area (lines)                                               | Rust replacement                                                                                                                                                                           | Risk                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `daemon/**`, `database.ts`, `events.ts` (~9k)                 | axum + tokio, rusqlite (bundled), serde                                                                                                                                                    | Medium: auth details, relay, schedules |
| `backends/**` + `@mariozechner/pi-ai` (MIT; ~4.9k lines used) | Native clients for `anthropic-messages`, `openai-completions`, `openai-responses`, `openai-codex-responses`; OAuth PKCE (Anthropic, Codex) and device flow (Copilot)                       | High: provider quirks                  |
| pi-ai model catalog                                           | JSON snapshot generated at dev time by a script, embedded with `include_bytes!`                                                                                                            | Low                                    |
| `agent/**` (~22.4k)                                           | `pirc-agent` crate; `Feature` trait with default no-op hooks                                                                                                                               | High: loop/queue/compaction parity     |
| `agent/ptc/**` (QuickJS WASM, acorn, `Bun.Transpiler`)        | `rquickjs` (native QuickJS, same semantics); oxc for type stripping and preflight AST checks; killable child process kept                                                                  | Medium: size of oxc, QuickJS limits    |
| `agent/auto-mode/rules.ts` (2k)                               | Pure-logic port with the existing tests as golden cases                                                                                                                                    | Low                                    |
| `node/**` (~6.7k), Fastify `app.inject` relay                 | Transport-independent request router over the node link                                                                                                                                    | Medium: `runner.ts` lifecycle          |
| Bun PTY (`node/terminals.ts`)                                 | `portable-pty` or `rustix` openpty                                                                                                                                                         | Low                                    |
| Git panels (shell out to `git`)                               | Keep shelling out with the same hardening flags                                                                                                                                            | Low                                    |
| `@anthropic-ai/sandbox-runtime` (srt, Apache-2.0)             | Native: Linux bwrap + seccomp BPF (`seccompiler`, passed via `--seccomp` fd) + in-process domain-filtering proxy + self-hosted socket bridge (replaces socat); macOS SBPL + `sandbox-exec` | **High: security regression**          |
| `playwright-core` (Apache-2.0)                                | Minimal hand-written CDP client over WebSocket; `ariaSnapshot({mode:'ai'})`/`aria-ref` via an injected script (spike); `Fetch` domain for the host guard; `Page.startScreencast`           | High: agent-visible snapshot format    |
| web-push, croner, zod                                         | `web-push`-compatible RFC 8291/VAPID with pure-Rust crypto; `croner`-equivalent cron + `chrono-tz` (DST and DOM/DOW tests); serde with `deny_unknown_fields`                               | Low–Medium                             |

TLS uses rustls. External runtime dependencies stay as today: `git`, `bwrap` (Linux), Chromium/Chrome and optional `ffmpeg` for the browser.

## Crate layout (proposal)

```
crates/
  pirc-protocol   node link, inference wire, agent RPC, client-facing types (serde)
  pirc-config     env parsing and allowlists (config.ts, env-allowlist.ts)
  pirc-policy     sandbox-policy.ts, PathGuard, SENSITIVE_HOME_PATHS
  pirc-store      SQLite schema and access (gateway and node)
  pirc-providers  model transports, OAuth, catalog
  pirc-agent      agent loop, tools, features, auto-mode
  pirc-ptc        rquickjs host and guest
  pirc-sandbox    Sandbox trait; linux (bwrap/seccomp/proxy) and macos (SBPL) backends
  pirc-browser    CDP client and browser service
  pirc-gateway    bin: gateway role (+ oauth-worker if still needed)
  pirc-node       bin: node and chat roles in one executable, subcommands agent, ptc-guest, sandbox helpers
  pirc-conformance  black-box conformance tests (test-only)
```

Release profile: `lto = "fat"`, `codegen-units = 1`, `strip = true`, `opt-level` chosen by measurement (`3` vs `"s"`). `cargo bloat` output is recorded per milestone.

## Milestones

### M0 Conformance harness (Rust, against the TS executables)

The harness drives real executables over HTTP and WebSocket only, so the same tests later run unchanged against the Rust executables. Snapshots accepted from the TS 0.3.0 build are the contract. The CLI (`version`, `help`, subcommands) is not part of it: the merged node executable changes it, and M9 re-specifies it.

- [x] Cargo workspace at the repository root with `crates/pirc-conformance` (test-only, `publish = false`); Rust toolchain in the flake dev shell; `cargo fmt --check`, `cargo clippy -- -D warnings` and the harness's unit tests in `bun run check`.
- [x] Harness: start `pirc-gateway` and `pirc-node` from `PIRC_CONFORMANCE_BIN_DIR` with isolated temporary state, config directory and `HOME`, a free port, a fake srt that runs the agent unconfined, and a scripted OpenAI-compatible SSE server in Rust as the only provider; wait for node registration; kill the processes on drop.
- [x] Normalizer: stable placeholders for generated ids, tokens, timestamps, temporary paths and ports that keep equal values equal; `insta` JSON snapshots.
- [x] Scenarios:
  - Auth matrix on a GET and a mutating route: untrusted peer, proxy secret missing/wrong/right, Host, Origin (missing on a mutation, not allowed), identity missing/not allowed, device token together with an identity, device-denied routes; error bodies.
  - Devices: pair, list, use the bearer token, revoke; an open `/api/events` socket closes with 4401 on revoke.
  - Node link, with the harness acting as a node: bad credentials 4401, protocol mismatch 4426, register then `registered`, heartbeat then `heartbeat_ack`, a second connection replacing the first with 4000.
  - Session lifecycle with the real agent and the fake model: workspaces, create, acquire control, prompt command (202), events until `agent_settled`, snapshot, duplicate command, cursor replay, `reset` for an expired cursor, release; `/api/events` close codes for unauthenticated, forbidden and unknown sessions.
- [x] `bun run test:conformance` builds nothing itself: it runs the harness against `apps/gateway/dist` after `bun run build`, and is part of `bun run check`. `INSTA_UPDATE=always` re-records.
- [x] CI workflow running `bun run check` (today CI covers Android only).

Acceptance: three consecutive runs against the TS build pass with no snapshot changes; snapshots are committed.

Done 2026-10-10. The agent's own event stream is a separate snapshot (`session_agent_events`), the parity target of M4/M5; the gateway-owned part of a session is `session_lifecycle`. Validation-error `details` (the TS validation library's report, read by no client) are left out of transcripts. The CI workflow has not run yet. Locally (NixOS), `bun run check` still stops at 24 gateway tests and 4 compiled-role tests that need `/bin/bash` (or its team workers); the change does not touch `apps/`.

### M1 Workspace skeleton, size budget and spikes

- [ ] Product crates under the M0 workspace; the workspace version added to `scripts/version.ts` manifests.
- [ ] `pirc-protocol` serde types, hand-ported from `protocol-schema.ts` and `inference-wire.ts`, round-trip the node-link frames the harness captures.
- [ ] CI job that builds release binaries and fails above a recorded size budget.
- [ ] **Spike A, browser snapshot:** run Playwright's injected aria-snapshot code (or an equivalent) through raw CDP `Runtime.evaluate` and compare `mode:'ai'` output and `aria-ref` resolution against `browser.ts` on a fixed page set.
- [ ] **Spike B, PTC size:** measure `rquickjs` + oxc (parser, type stripping) binary cost; fallback options if too large.
- [ ] **Spike C, Linux sandbox:** bwrap + seccomp BPF + domain-filtering proxy + socket bridge running `/bin/sh -c 'exit 0'` and the `sandbox*.integration` cases.

**Gate:** record the spike results and the size budget per binary here before M2.

### M2 Gateway core

Runs against TS nodes over node protocol v9 (development only; the release is not mixed).

- [ ] Config, error shape `{error:{code,message,details?}}`, auth middleware (`daemon/auth.ts`, `daemon/devices.ts`) with constant-time comparisons.
- [ ] Fresh SQLite schema (consolidated from `database.ts` migrations, new `user_version` line). If a TS-era database is found in the state directory, refuse to start with a message pointing to the migration notes.
- [ ] EventHub (epoch, sequence, cursor, `reset`) and `/api/events` with hint frames.
- [ ] `/node/connect` registry, request relay, terminal and browser stream relays, inference multiplexing (`daemon/nodes.ts`).
- [ ] Sessions, commands (idempotency), leases, interactions, uploads, workspaces, capabilities, trust.
- [ ] Devices and pairing, push (VAPID), schedules, delegations, memory, agent-ops, web search.

Acceptance: all M0 gateway scenarios pass with Rust gateway + TS node; `fixtures/timeline` passes; size within budget.

### M3 Model backends (removes pi-ai)

- [ ] Backend settings store (0600 atomic writes), discovery, `models.json` with SIGHUP reload.
- [ ] Native transports for the four wire APIs, producing `inference-wire` deltas (`text_*`, `thinking_*`, `toolcall_*`) and error codes; parity tests from `pi-adapter.test.ts`, `inference-transport.test.ts`, `opencode-go.test.ts` against recorded SSE fixtures.
- [ ] OAuth: Anthropic and Codex PKCE (fixed localhost redirects and manual paste-back), Copilot device flow and token minting, serialized refresh with revision checks; fake-provider tests from `backend-auth.test.ts`.
- [ ] Catalog snapshot script and embedded catalog.

**Gate:** real-provider smoke tests cost money and need the user's approval and credentials.

### M4 Agent core

Runs as the session agent under a TS node (same `configure` + JSONL RPC).

- [ ] Message types, session store (fresh format allowed, but keep the tree with `id`/`parentId`), config, roles.
- [ ] RPC server, `configure`, remote provider over the node's Unix socket, side channels (`gateway_*`, `extension_ui_*`, write lease, sandbox, browser).
- [ ] Loop, queues (prompt/steer/follow-up), retry, cancellation, compaction with matching token estimation and thresholds.
- [ ] Core tools: `read`, `write`, `edit`, `ls`, `grep`, `find`, `bash`; user hooks (`hooks.ts`).

Acceptance: recorded RPC transcripts replay with equivalent events; fake-llm end-to-end scenarios pass.

### M5 Agent features, auto mode and PTC

- [ ] `Feature` trait; todo, goal, title, recap, skills, project instructions, ask-question, web search, compact, role, schedules, sandbox approvals.
- [ ] Auto-mode rules and classifier, porting `auto-mode-rules.test.ts` and `agent-auto-mode.test.ts` as golden cases.
- [ ] PTC on `rquickjs` in a killable `ptc-guest` child with empty environment; same limits (operations, concurrency, time, heap, source size), broker checks and refusal semantics; port `agent-ptc.test.ts` and `ptc-runtime.test.ts`.
- [ ] Memory (observational and workspace), background tasks, team/subagents, assistant.

**Gate:** before cutover, re-run the PTC and task-time evaluations against the TS baseline (`docs/evaluations/ptc/`). Paid runs need the user's approval.

### M6 Node and chat roles

- [ ] One executable for both roles; the role selection (subcommand or `PIRC_CHAT`) is decided with the user before this milestone starts.
- [ ] Node link (register, 15 s heartbeat, 3 s reconnect, loopback-only `ws://`), request router replacing `app.inject`.
- [ ] Runner: spawn, epochs, snapshots, reducer, interactions; RPC framing (LF only, line cap); inference Unix socket; write broker; secrets/env allowlist.
- [ ] Panels: files (realpath containment), git, context, memory panel; terminals (limits, scrollback, process-group kill); memory mirror; recap; chat workspace layout.
- [ ] Sandbox trait wired to the M1 spike implementation (Linux). TS srt may be used only as a development stand-in.

Acceptance: full M0 scenario suite passes with Rust gateway + Rust node + Rust agent.

### M7 Native sandbox

- [ ] Linux: complete policy mapping (read denials, write allowlist, read-only `.pirc/`, `.git/hooks`, `.git/config`, rc files), seccomp, network proxy with runtime domain approval, Unix-socket handling.
- [ ] macOS: SBPL generation and the same proxy; test on a macOS node.
- [ ] Port `sandbox-policy.test.ts`, `sandbox.integration`, `sandbox-srt.integration`; add escape tests.

**Gate:** a dedicated security review (recorded under `plans/security-audit.md` or a new audit) before any release.

### M8 Native browser

- [ ] CDP client: persistent per-workspace profile, tabs per session, snapshot/ref interaction model from spike A, host guard (`browser-hosts.ts`) via the `Fetch` domain, screencast live view with backpressure, input forwarding, handoff lease, extraction, ffmpeg recording and chunked upload.
- [ ] Port `browser.test.ts`, `browser-hosts.test.ts`, `browser.integration.test.ts`.

### M9 Cutover

- [ ] Nix: `rustPlatform.buildRustPackage` for `pirc-gateway` and `pirc-node`; NixOS module updates (the chat service runs `pirc-node`); macOS release archive (`scripts/package-release.ts`).
- [ ] `NODE_PROTOCOL_VERSION` 10.
- [ ] CLI contract for the two executables (version, help, subcommands, role selection) as conformance tests.
- [ ] Docs: deploy guides, `docs/deploy/upgrades.md` fresh-start migration notes, README requirements (no Bun at runtime), CHANGELOG breaking-change entry, version bump.
- [ ] Remove the TS server sources and Bun build scripts from `apps/gateway` (web and Android stay; Bun remains a dev/build tool for the web and test harness).
- [ ] Record final binary sizes against the 0.3.0 baseline.

**Gate:** the user approves cutover after M5/M7 gates are satisfied.

## Open questions

- How the merged `pirc-node` selects the chat role (before M6).
