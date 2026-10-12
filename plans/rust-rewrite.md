# Rust rewrite of the server executables

Status: M0, M1 and M2 done 2026-10-10; M3, M4, M5 and M6 done 2026-10-11 (M3's real-provider smoke test moved to M5's gate, which stays open until cutover); M7 done 2026-10-12 (its gate's security review is recorded; its one open finding, S10, was accepted by the user); M8 next. Each milestone needs the user's go-ahead before implementation, and the gates marked **Gate** need an explicit decision recorded here before work continues past them.

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

- [x] Product crates under the M0 workspace; the workspace version added to `scripts/version.ts` manifests.
- [x] `pirc-protocol` serde types, hand-ported from `protocol-schema.ts` and `inference-wire.ts`, round-trip the node-link frames the harness captures.
- [x] CI job that builds release binaries and fails above a recorded size budget.
- [x] **Spike A, browser snapshot:** run Playwright's injected aria-snapshot code (or an equivalent) through raw CDP `Runtime.evaluate` and compare `mode:'ai'` output and `aria-ref` resolution against `browser.ts` on a fixed page set.
- [x] **Spike B, PTC size:** measure `rquickjs` + oxc (parser, type stripping) binary cost; fallback options if too large.
- [x] **Spike C, Linux sandbox:** bwrap + domain-filtering proxy + socket bridge running `/bin/sh -c 'exit 0'` and the spike's own policy checks (seccomp turned out to be unused by pirc; the node-level `sandbox*.integration` cases belong to M6/M7).

**Gate:** record the spike results and the size budget per binary here before M2.

Done 2026-10-10; gate decided with the user the same day. The spikes are in `spikes/`, each with its README and numbers.

- **Size budget:** `pirc-gateway` 16 MiB, `pirc-node` 32 MiB (`crates/size-budget.json`, checked by `bun run size:check` and CI on Linux x86_64; the macOS ARM64 release build is measured at M9). Raising it needs a recorded reason. Today's placeholders are 0.31 MiB, so the check bites only once real code lands.
- **Protocol:** `pirc-protocol` round-trips every frame the conformance suite sees from real executables: `register`, `response`, `event`, `model_start` from a node; `registered`, `heartbeat_ack`, `request` from the gateway. The other frame kinds are covered only by hand-written unit fixtures so far; M2 and M6 add scenarios for them. A new scenario, `node_side_link`, plays the gateway to a real node and records the node's half of the link for M6. Maps keep their order (`serde_json` `preserve_order`, `IndexMap`; unit-tested), since the first provider is the default and tool schemas are model-visible text; struct field order is not compared.
- **Spike A, browser (`spikes/browser-snapshot`):** Playwright's injected script evaluated over a hand-written CDP client gives the same AI snapshots on the test pages except for the frame prefix of refs (Playwright's `f3e2` against the spike's `e2`; M8 reproduces Playwright's per-context frame numbering), and `aria-ref` fill and click work through CDP input events. Missing: child frames, which Playwright snapshots separately and merges with per-frame ref prefixes. About 0.9 MiB plus 313 KiB of embedded JavaScript.
- **Spike B, PTC (`spikes/ptc-size`):** rquickjs adds 1.3 MiB and oxc 2.2 MiB (2.1 MiB together at `opt-level="z"`); type stripping, the `tools.<name>` manifest, async host calls, the interrupt deadline and the heap limit work. The killable child process stays (regular expressions are not interruptible).
- **Spike C, Linux sandbox (`spikes/linux-sandbox`):** bubblewrap with srt's argument order, a network namespace, a filtering proxy on a Unix socket, an in-sandbox bridge replacing socat and runtime domain approval pass the spike's 20 checks at about 15 ms per start; 505 KiB. Run as a normal user only: `--cap-drop ALL` is passed but not tested, and M7 must test uid 0. pirc already runs srt without seccomp on Linux (`allowAllUnixSockets`), so seccomp is not needed. srt's filesystem argument generation handles many symlink, missing-path and scan cases the spike does not; M7 ports that algorithm rather than redesigning it.
- The release profile keeps `opt-level=3`; `"z"` and `panic = "abort"` are left for measurement once real code exists.

### M2 Gateway core

Runs against TS nodes over node protocol v9 (development only; the release is not mixed).

Decided with the user before starting (2026-10-10):

- **Inference:** M2 brings forward a minimal native `openai-completions` transport and `models.json` loading, enough for the conformance fake provider, so the session scenarios run with the Rust gateway. M3 adds the other three wire APIs, OAuth, the settings store and discovery.
- **Backend routes** (`/api/providers*`, `/api/provider-auth/*`, `backends/routes.ts`) belong to M3; the M2 gateway does not serve them.
- **Cadence:** one commit per sub-item below, each starting with conformance scenarios for its area recorded against the TS build. `PIRC_CONFORMANCE_GATEWAY_BIN` runs the suite with another gateway executable (the Rust one) next to the TS node; until M2 is done that run is not part of `bun run check`.

- [x] Config, error shape `{error:{code,message,details?}}`, auth middleware (`daemon/auth.ts`, `daemon/devices.ts`) with constant-time comparisons.
- [x] Fresh SQLite schema (consolidated from `database.ts` migrations, new `user_version` line). If a TS-era database is found in the state directory, refuse to start with a message pointing to the migration notes.
- [x] EventHub (epoch, sequence, cursor, `reset`) and `/api/events` with hint frames.
- [x] `/node/connect` registry, request relay, terminal and browser stream relays, inference multiplexing (`daemon/nodes.ts`).
- [x] Sessions, commands (idempotency), leases, interactions, uploads, workspaces, capabilities, trust.
- [x] Devices and pairing, push (VAPID), schedules, delegations, memory, agent-ops, web search.

Acceptance: all M0 gateway scenarios pass with Rust gateway + TS node; `fixtures/timeline` passes; size within budget.

Done 2026-10-10. With `PIRC_CONFORMANCE_GATEWAY_BIN=target/debug/pirc-gateway` every scenario passes against the TS node, and `bun run check` now runs that too (`test:conformance:rust-gateway`); `fixtures/timeline` is unchanged and passes. `pirc-gateway` is 10.71 MiB (chrono-tz's zone data is most of the growth since sub-item 4). Sub-items 1–4 landed first; sub-item 6 was ported in parallel (push, memory, schedules, delegations with web search) behind interfaces laid out first, then reviewed through security, correctness and schedule lenses. New scenarios recorded against TS: `http_edges`, `event_stream`, `session_routes`, `relayed_streams`, `push`, `memory` (with the chat-workspace paths of sub-item 5), `schedules`, `delegations`, `delegation_expiry`. Notes:

- The gateway's database lives in `pirc-gateway` (`db.rs`, `schema.sql`), not a shared `pirc-store`: the node's store has nothing in common with it. Tables the TS gateway created but never wrote (`runs`, `interactions`, `uploads`, `workspace_trust`) are gone; `user_version` is 1000, and 1–999 (the TS migrations) is refused.
- `pirc-providers` holds `models.json` loading and the M2 inference transport: the native `openai-chat` port and pi-ai's `openai-completions`, checked against 43 recordings of the TS gateway (`tests/parity`). Known gaps: SDK telemetry headers, Bun's network error texts, non-object tool arguments (sent as `{}`).
- Framework behavior clients can see is reproduced where recorded: Fastify's 404 and 414 bodies, JSON body parsing errors as 500, `no-store` on device and backend routes even when authentication fails, and the double `node_offline` when a node's link is replaced (Bun's `ws` closed the old socket synchronously). The 4 KiB limit on browser messages to `/api/events`, which never took effect under Bun, is enforced.
- Replaced libraries: `web-push` by RFC 8291/8292 on p256, aes-gcm and hkdf (RFC appendix vector as a test); `croner` by a line-by-line port (`schedules/cron.rs`), compared with croner 10.0.1 on 100k generated cases. Feature state lives in typed slots on the app (`slots.rs`); unusable VAPID keys stop the gateway before it listens.
- Accepted gaps: one-shot schedule times must be ISO 8601 (Bun's `Date.parse` took more forms); `US/Pacific-New` and `Canada/East-Saskatchewan` are unknown to chrono-tz; a UTF-16 cut through a surrogate pair gives U+FFFD; the gateway's own HTTP clients ignore proxy variables, as Node's `fetch` did; search dates use the system zone files through `tz-rs`.

### M3 Model backends (removes pi-ai)

Done 2026-10-11.

Decided with the user before starting (2026-10-11):

- **OAuth runs in the gateway process** (tokio tasks with abort), not in an `oauth-worker` subprocess: the subprocess isolated third-party pi-ai code, and the Rust code reads no gateway environment. Behavior is kept: prompt/manual/select prompts, the 10-minute deadline, serialized refresh, generation checks.
- **Both Anthropic transports are ported:** the native `agent/providers/anthropic.ts` (plain `anthropic-messages` providers) and pi-ai's (OAuth, presets, model-level `api`), so requests stay byte-identical to TS.
- **Cadence as in M2:** one commit per sub-item, each starting with conformance or parity recordings from the TS build. Order: catalog, then settings store with routes and discovery, then transports, then OAuth.

- [x] Backend settings store (0600 atomic writes), discovery, `models.json` with SIGHUP reload.
- [x] Native transports for the four wire APIs, producing `inference-wire` deltas (`text_*`, `thinking_*`, `toolcall_*`) and error codes; parity tests from `pi-adapter.test.ts`, `inference-transport.test.ts`, `opencode-go.test.ts` against recorded SSE fixtures.
- [x] OAuth: Anthropic and Codex PKCE (fixed localhost redirects and manual paste-back), Copilot device flow and token minting, serialized refresh with revision checks; fake-provider tests from `backend-auth.test.ts`.
- [x] Catalog snapshot script and embedded catalog.

**Gate:** real-provider smoke tests cost money and need the user's approval and credentials.

Decided with the user (2026-10-11): the real-provider smoke test is deferred to M5's gate and run together with its paid evaluations; M3 is done without it.

Progress notes:

- Catalog (2026-10-11): `scripts/model-catalog.ts` snapshots pi-ai 0.73.1's catalog into `crates/pirc-providers/catalog.json` (186 KB, embedded) for the providers whose every model uses one of the four wire APIs; `cost` is dropped. `bun run check` fails on a stale snapshot.
- Settings store (2026-10-11): `pirc_providers::backends::BackendService` (store, merge, snapshot, presets, discovery, connection test) and the gateway's `/api/providers*` routes; scenario `backends` recorded against TS passes with the Rust gateway. `settings.json` keeps the TS path and shape (version 1), since the gateway already refuses a TS-era state directory. The provider-auth routes check their input as TS does, but a valid login start answers 503 until the OAuth sub-item, and `oauth:` providers do not resolve yet. Connection tests run on their own transports, so configuration changes do not cancel them (TS built a fresh `GatewayInference` per test). Reproduced quirks: a `baseUrl` string that is not a URL is a 500 (zod runs the refinement after `.url()` failed); static `/api/providers/<name>` paths of one method do not hide `{id}` for other methods (Fastify routes per method). Accepted gap: integer-like backend IDs (`"7"`) keep insertion order, where JS objects list them first (also true of M2's `models.json`). `pirc-gateway` is 11.23 MiB.
- OAuth (2026-10-11): `backends/auth.rs` (sessions, prompts, pasted-callback checks, serialized refresh) and `backends/oauth/flows.rs` (pi-ai's three logins and refreshes, the callback servers on 53692 and 1455, PKCE, pi-ai's callback page verbatim). Scenario `provider_auth` (real login starts up to the first provider request: authorization URLs, prompts, callback checks, the callback servers, cancel and sign-out) recorded against TS passes with the Rust gateway; the flows are unit-tested against local stand-ins for the providers. Kept from the TS worker: replies capped at 1 MB, only `HTTP(S)_PROXY`/`NO_PROXY` used (not `ALL_PROXY`); added: 30 s per request, a revision check so a refresh never spends an already rotated refresh token (TS read and refreshed in one tick), concurrent callback connections (at most 16). Inherited from pi-ai and left as they are: Anthropic's `state` is the PKCE verifier and the callback servers bind 127.0.0.1 only (a local process on `[::1]` could take the redirect), and the GitHub Enterprise domain may name any HTTPS host, with redirects followed. pi-ai's `select` prompts, which none of the three providers uses, are not ported.
- Transports (2026-10-11): pi-ai's `anthropic-messages` (with the subscription branch: Claude Code identity, tool-name mapping), `openai-responses` and `openai-codex-responses` (SSE only; the adapter forced it), and the native `anthropic-messages`, ported in parallel worktrees behind a layout commit (`pi.rs`, routing, per-transport parity groups). 260 scenarios recorded from the TS gateway (`tests/parity/fixtures/*.json`, re-record with `bun crates/pirc-providers/tests/parity/record.ts [group]`) replay identically; reviewed through correctness and security lenses. Accepted gaps: stream values the wire types cannot hold (non-string deltas stringified, non-object tool arguments as `{}`, negative usage counts as 0, serde's number formatting in replayed values); unpaired UTF-16 surrogate escapes become U+FFFD instead of being re-joined across events; Bun's joining of header names that differ only in case is reproduced in the native transport only; an aborted message may include metadata TS added only between chunks; the SDKs' environment credentials (`ANTHROPIC_AUTH_TOKEN`) are not read; redirects keep non-`Authorization` key headers across hosts, as Bun's `fetch` did; Cloudflare base URLs still expand `{VAR}` from the gateway environment (pi-ai; reachable only from `models.json`). Cancelling while a subscription token refreshes now ends the run as cancelled. The `codex` group's retry delays add about 10 s to every parity run. `pirc-gateway` is 11.84 MiB.

### M4 Agent core

Runs as the session agent under a TS node (same `configure` + JSONL RPC).

Done 2026-10-11. `pirc-node agent` runs the Rust agent (`crates/pirc-agent`, path rules shared through `crates/pirc-policy`); the TS node starts it through `PIRC_AGENT_COMMAND`. 21 agent transcripts recorded from the TS agent with features off (`crates/pirc-conformance/tests/agent_*.rs`: loop, queues, retries, tools, hooks, auto mode, `ptc_docs`, compaction, RPC lines and startup, session store, line order with responses, and the Rust agent under the real TS node) pass against the Rust agent, and `bun run check` runs them (`test:conformance:rust-agent`). Reviewed through loop, components, concurrency and security lenses in two rounds; the auto-mode rules were compared with `rules.ts` on about 243,000 generated commands and 96 deny patterns with identical verdicts. Release sizes: `pirc-gateway` 11.84 MiB, `pirc-node` 3.73 MiB (the TS node binary is 101 MB).

- Rust-only safeguards: a shell's process group is killed when its run is dropped and before the agent exits on a crash or second signal; `find` stops on abort (TS's synchronous walk could not); the glob matcher runs without recursion and gives up on a path past 2^20 steps, past 4,096 brace alternatives or 4 M expanded characters (Bun would keep matching); a panic in the loop reaches the node as `Agent loop crashed: internal error`.
- Until M5's classifier, `useModel: true` (the default) takes TS's classifier-failure path: one warning, unclear shell actions treated as writes.
- Accepted gaps: `ls` order approximates `localeCompare` (exact for ASCII and Latin-1); deny-list and `grep` regexes use `regress`, which matches by code point and reads `\u{…}` as an escape without the `u` flag; JSON, YAML and session-write error texts are not Bun's; integer-like object keys keep insertion order; session lines with lone surrogate escapes or nesting past 128 are skipped; the interrupted note's JSON key order; a second identical signal exits with 128+n instead of dying by the signal, and signals after stdin ends are ignored (no `unsafe` to reset handlers); about 0.03% of odd `**` patterns already differed from `Bun.Glob`.
- Holes the review found in both builds (fd/rg/bat running programs, "read-only" commands that write, `..` after a symlink, wget uploads) are recorded in `plans/security-audit.md` for after cutover.

Decided with the user before starting (2026-10-11):

- **Acceptance without features:** the M0 `session_agent_events` snapshot depends on M5 features (todo, background, goal, memory panel; their tools and prompt sections), so M4 is accepted on agent-level JSONL RPC transcripts recorded from the TS agent with its built-in features turned off by a development-only switch (`PIRC_AGENT_FEATURES=none`; a small change to `apps/` that production never sets). The harness plays the node: it starts the agent directly, sends `configure`, serves the inference socket with scripted replies and answers side-channel requests. Full M0 agent-event parity is M5's.
- **Session format:** `session.jsonl` v1 stays field-for-field compatible, because the TS node reads it (branch cache, recap) while the Rust agent runs under it. A new format can be weighed at M6.
- **PTC surface and auto-mode rules move into M4:** the model sees `ptc`, `ptc_docs` and the capability index in every request, and every `bash` call passes the auto-mode rules (deny-list and write-lease decision) even with auto mode off. M4 therefore ports the capability registry, signatures, index prompt, the `ptc`/`ptc_docs` tool definitions with `ptc_docs` lookups, and `auto-mode/rules.ts` (with `auto-mode-rules.test.ts` as golden cases). The PTC runtime (rquickjs, `ptc-guest`) and the model classifier stay in M5; transcripts run with `features.autoMode.useModel: false`.
- **Cadence as in M3:** transcripts recorded from TS first, then a layout commit with the `pirc-agent` crate's interfaces, then parallel worktrees (store/messages/config; RPC, side channels and the remote provider; tools and hooks), with the loop and compaction done by the parent; reviews through several lenses; one commit per sub-item.

- [x] Message types, session store (fresh format allowed, but keep the tree with `id`/`parentId`), config, roles.
- [x] RPC server, `configure`, remote provider over the node's Unix socket, side channels (`gateway_*`, `extension_ui_*`, write lease, sandbox, browser).
- [x] Loop, queues (prompt/steer/follow-up), retry, cancellation, compaction with matching token estimation and thresholds.
- [x] Core tools: `read`, `write`, `edit`, `ls`, `grep`, `find`, `bash`; user hooks (`hooks.ts`).
- [x] PTC surface (capability registry, signatures, index prompt, `ptc`/`ptc_docs` definitions and `ptc_docs` lookups) and the auto-mode rules (`auto-mode/rules.ts`, golden cases from `auto-mode-rules.test.ts`).

Acceptance: recorded RPC transcripts replay with equivalent events; fake-llm end-to-end scenarios pass.

### M5 Agent features, auto mode and PTC

Decided with the user before starting (2026-10-11):

- **Acceptance:** agent-level JSONL RPC transcripts recorded from the TS agent with chosen features on (`PIRC_AGENT_FEATURES` grows from `none` to a comma-separated list of feature names; still development-only) replay against the Rust agent; the M0 `session_agent_events` snapshot passes with the TS gateway, the TS node and the Rust agent (`PIRC_AGENT_COMMAND`); `agent-auto-mode.test.ts`, `agent-ptc.test.ts` and `ptc-runtime.test.ts` are ported as golden cases.
- **The browser feature** (`features/browser.ts`, the agent's browser tools over the side channel ported in M4) is ported in M5; M8 is the node's CDP side only.
- **PTC tests:** only `agent-ptc.test.ts` and `ptc-runtime.test.ts` (plus `ptc-signatures.test.ts` where M4 did not cover it). The `ptc-m1-*`/`ptc-m4-*` evaluation harness stays in TS and runs at the gate against the TS baseline and the Rust build.
- **Cadence as in M4:** transcripts recorded from TS first, then a layout commit with the `Feature` trait and interfaces, then parallel worktrees for the features, with loop integration done by the parent; reviews through several lenses; one commit per sub-item. Order: the trait and the simpler features, the classifier, the PTC runtime, then memory, background tasks, team and assistant.

- [x] `Feature` trait; todo, goal, title, recap, skills, project instructions, ask-question, web search, compact, role, schedules, sandbox approvals, browser.
- [x] Auto-mode classifier (the rules moved to M4), porting `agent-auto-mode.test.ts` as golden cases.
- [x] PTC runtime (its surface moved to M4) on `rquickjs` (spike B; use `AsyncContext::async_with`, not the deprecated macro) in a killable `ptc-guest` child with empty environment; same limits (operations, concurrency, time, heap, source size), broker checks and refusal semantics; port `agent-ptc.test.ts` and `ptc-runtime.test.ts`.
- [x] Memory (observational and workspace), background tasks, team/subagents, assistant.

Done 2026-10-11 (the gate below stays open until cutover). All seventeen built-in features, the classifier and the PTC runtime run in `pirc-node agent`; QuickJS and oxc live in `crates/pirc-ptc` (guest behind its default `guest` feature, `pirc-node ptc-guest`). 128 new agent transcripts recorded from the TS agent (`crates/pirc-conformance/tests/agent_*.rs`, 149 with M4's; the `_ptc` files drive feature tools through scripts) replay against the Rust agent, and the M0 `session` scenario (`session_agent_events` included) passes with the TS gateway, the TS node and the Rust agent; `bun run check` runs both (`test:conformance:rust-agent`). `ptc-runtime.test.ts` is ported as `crates/pirc-agent/tests/ptc_runtime.rs`; `ptc-signatures.test.ts` was already covered by M4. Reviewed through security, loop, feature and stateful-feature lenses, then a second round on the fixes. Release sizes: `pirc-gateway` 11.83 MiB, `pirc-node` 10.12 MiB.

- The TS agent's microtask order is emulated where transcripts showed it matters: `crate::tick` (one microtask), `crate::set_timeout_zero` (`setTimeout(…, 0)` in order), a one-feature run admitting before the command's response, `flush_panel` where TS's coalescing microtask ran, a yield after side-channel answers. Elsewhere the order of `panel_changed` lines and responses may differ from TS.
- Rust-only safeguards: ptc preflight runs on its own 256 MiB stack (oxc recursion would otherwise abort the agent on a deeply nested script within the size budget; TS refused those with "Maximum call stack size exceeded" and Rust may accept them); the guest dies with its agent (parent-death signal) and is killed when its stdout ends; `AbortSignal::any` holds dependents weakly; leftover background and team process groups are killed.
- Accepted gaps: oxc syntax-error texts and printed line numbers (multi-property objects are broken over lines); quickjs-ng instead of Bellard's QuickJS (stack formats, OOM and stack-overflow messages, `performance`/`queueMicrotask` globals); `AsyncContext::async_with` is not used (the guest drives the job queue itself, as `guest.ts` did, to report idleness); lone surrogates crossing the realm become U+FFFD; the guest exits by itself after `done` and refuses a terminal stdin; the TS catch around a throwing static rule and a throwing stream function has no Rust path; title input cut at 2,000 UTF-16 units keeps surrogate pairs whole; `/constructor`-like slash names are prompts; team `team_cancel` comes after an abort's response, and a child's last stdout lines are awaited up to 1 s before its exit; background piped tasks use `setpgid` (Bun's `detached` made a session); goal timer errors and malformed gateway or node answers fail with Rust's own texts; memory parses only the `YYYY-MM-DDTHH:MM` local date form for drop order; a preflight still blocks the agent while it runs (one pathological 64 KiB shape takes about 20 s; TS blocked too).
- The native guest loses the WASM layer TS's QuickJS ran in; recorded as S6 in `plans/security-audit.md`, to be hardened (no_new_privs, seccomp, rlimits) with M7.

**Gate:** before cutover, re-run the PTC and task-time evaluations against the TS baseline (`docs/evaluations/ptc/`). Paid runs need the user's approval. The real-provider smoke test deferred from M3 (each wire API and subscription login: one text turn and one tool call) runs with them.

### M6 Node and chat roles

Decided with the user before starting (2026-10-11):

- **Role selection: a subcommand.** `pirc-node chat` runs the chat role, next to the internal `agent` and `ptc-guest` subcommands; `PIRC_CHAT` stays removed and the role is not taken from `argv[0]`. `pirc-node` without a subcommand runs the coding node.
- **Sandbox: a native Linux backend plus an srt-compatible mode.** By default the agent runs under spike C's bubblewrap, filtering proxy and in-sandbox bridge (an internal `pirc-node` helper subcommand); a runtime network approval widens the proxy's allowlist directly instead of writing to a control fd. `PIRC_SANDBOX_SRT` keeps naming an external srt-compatible CLI (`--settings`, `--control-fd 3`, `--`) as the development stand-in, which the conformance harness's fake srt uses. `sessionPolicy` (pure logic) moves to `pirc-policy` now, with `sandbox-policy.test.ts` as golden cases. srt's filesystem argument generation, macOS, SOCKS5 and the escape tests stay in M7; on other platforms agents do not start (503, as when the sandbox is unavailable).
- **Browser: reported unavailable until M8.** The browser settings are parsed, but the browser service is a stub: agents get `PIRC_BROWSER=0`, `browser_request` answers 403 "The browser is not available on this node", browser streams close with 4403. The recording route only reads files and is ported. A node with Chromium installed therefore has no browser until M8.
- **Acceptance:** the existing suite plus new node scenarios recorded from the TS build (git, files, panel state and context, memory panel, terminals with their limits and `PIRC_TERMINALS=0`, uploads, interactions, deliver, session delete and rename, control, activity, reconnect, `models` frames, `agent_request`, `memory_mirror` and its ack, sandbox approvals through the fake srt, and a chat node: `pirc-chat` for TS, `pirc-node chat` for Rust) pass with the Rust gateway, the Rust node and the Rust agent, run by `bun run check` (`test:conformance:rust-node`). The pure-logic TS tests are ported as golden cases: `rpc-framing`, `node-secrets`, `events-reducer`, `memory-mirror`, `node-recap`, the node half of `inference-transport`, and `sandbox-policy`.
- **`unsafe`:** the workspace keeps `unsafe_code = "forbid"`; the PTY (`setsid`, `TIOCSCTTY`) and passing fd 3 to srt use third-party crates that hold the `unsafe` (`portable-pty`, `command-fds` or similar), as `nix` already does.
- **Store and cadence:** the node gets its own fresh SQLite schema with only the tables it uses (no TS-era database is read, as in M2). Scenarios are recorded from TS first, then a layout commit, then parallel worktrees, with reviews through several lenses and one commit per sub-item, as in M4 and M5.

Layout: `crates/pirc-node` became a library plus the binary, with the ownership table in its `lib.rs`; four workers port in parallel: core (store queries, router, link client, `app`/`chat` routes, start-up and shutdown), runner (runner, reducer, framing, inference socket, write broker, agent gateway, branch cache, recap, `pirc_config::env_allowlist`), panels (panel routes, git and files, terminals, stream mux, memory mirror) and sandbox (the srt wrapper, the native Linux backend and its `sandbox-bridge` helper, `pirc_policy::session`).

- [x] One executable for both roles (`pirc-node chat` selects the chat role).
- [x] Node link (register, 15 s heartbeat, 3 s reconnect, loopback-only `ws://`), request router replacing `app.inject`.
- [x] Runner: spawn, epochs, snapshots, reducer, interactions; RPC framing (LF only, line cap); inference Unix socket; write broker; secrets/env allowlist.
- [x] Panels: files (realpath containment), git, context, memory panel; terminals (limits, scrollback, process-group kill); memory mirror; recap; chat workspace layout.
- [x] Sandbox trait wired to the M1 spike implementation (Linux). TS srt may be used only as a development stand-in.

Acceptance: full M0 scenario suite passes with Rust gateway + Rust node + Rust agent.

Done 2026-10-11. `pirc-node` and `pirc-node chat` run the Rust node; the whole conformance suite passes with the Rust gateway, the Rust node and the Rust agent (`bun run test:conformance:rust-node`, part of `bun run check`). 20 new scenarios recorded from the TS build (`crates/pirc-conformance/tests/node_*.rs`: panels, sessions and commands, interactions, terminals, workspaces and project trust, the chat role and its start-up refusals, and the node's half of the link with activity, `agent_request`, recap, inference errors and cancels, the memory mirror and sandbox approvals through the fake srt) pass against both nodes; the harness gained `PIRC_CONFORMANCE_NODE_BIN` and chat nodes. The TS golden cases named above are Rust unit tests; the native backend has its own tests under bubblewrap (`crates/pirc-node/tests/sandbox_native.rs`; bubblewrap is now in the dev shell). Reviewed through security, concurrency, core and feature lenses, then a second round on the fixes. Release sizes: `pirc-gateway` 11.84 MiB, `pirc-node` 16.41 MiB.

- Gateway fixes found by the new scenarios: `registered` is queued before a node can be relayed to (a request could overtake it, and nodes drop frames before `registered`); a workspace added from the web is listed by `/api/nodes` with the node's whole answer, as TS did.
- TS's single thread is emulated where the review showed it matters: a runner reduces, books and publishes each agent line as one step, and a snapshot reads its live state, dialogs, run and watermark between two lines (history after them); `interaction_answered` precedes the agent's reply; a new runner waits for the old one's exit to finish; network approvals are applied under the runner's lock.
- Rust-only safeguards: new starts are refused (503) while the node shuts down, which waits for the starts in flight; the soft `RLIMIT_NOFILE` is raised to the hard limit, as Bun did; Unix socket paths longer than `sockaddr_un` are reached through `/proc/self/fd` (Bun handled them); the inference socket bounds chunk sizes and keeps its counters in drop guards; no single-pid kill after the agent was reaped; a withdrawn sandbox request never shows a dialog or spawns its command; the native proxy is capped per session (64) and per node (512).
- Accepted gaps: Bun and zod error texts where they are not client-visible contracts (start-up, config, spawn); a second signal exits 128+n; log lines are text; equal timestamps break ties by insertion order; the link refuses frames TS's schema accepted with fractional watermarks or statuses past 16 bits; inference requests with fractional numbers are refused, one HTTP request per inference connection; the RPC framing counts each invalid UTF-8 byte once and treats nesting past 128 or lone surrogates as fatal; the reducer coerces unexpected types with JS `String()`; a failed agent spawn answers 503 instead of `runner_ready` then `runner_error`; after the group is killed the agent's last stdout lines are handled for up to a second before `runner_exit`; the branch cache compares modification times in nanoseconds; recap excludes only node-local markers (a node has no schedule or delegation tables); git's stderr is read alongside stdout; a stream that fails to open unexpectedly closes 4400 "Internal server error"; `config.json` of `null` counts as empty. Host exec stays in the node's session (TS used `setsid`; a command opening `/dev/tty` reaches the node's terminal when it runs in one), left for after cutover.
- The browser is the M6 stub (403 to the agent, 4403 to streams). The native sandbox's gaps and the review's sandbox findings (S7–S9 in `plans/security-audit.md`: rename bypass of protected paths in srt and TS, panel git trusting agent-writable repository config, the PTY master briefly inheritable) are M7's.

### M7 Native sandbox

Decided with the user before starting (2026-10-12):

- **macOS is tested on a real Mac** (`ssh m3air`, macOS 26.5 arm64, cargo without nix): SBPL generation and the shared proxy are ported here, checked with golden profiles from srt 0.0.78 and run there.
- **uid 0:** detection and the missing-`CAP_SETFCAP` path are tested automatically inside user namespaces (`unshare -r`, uid 0 in the namespace, `CAP_SETFCAP` dropped), and in rootless podman containers, the usual way a node runs as root: container root with podman's default capabilities and with `--cap-drop SETFCAP`, bubblewrap nested inside. The podman tests are skipped when `podman` is missing and run in CI (installed there); tests that need real host root are `#[ignore]` and handed to the user as `sudo` commands. The backend stays bubblewrap: podman is a test environment only.
- **Panel git (S8) runs inside the sandbox:** bubblewrap (or Seatbelt) with the workspace's read policy, read-only, no network. Without a working sandbox the Git panel is unavailable.
- **Network scope:** what srt does by default with the settings pirc passes (SOCKS5 with its environment variables, denied domains, local binding, runtime approval, resolved-address checks); srt's TLS termination, MITM and credential masking, which pirc never configures, are not ported.
- **Cadence as in M4–M6:** a layout commit, parallel worktrees, reviews through several lenses, one commit per sub-item. The gate's security review runs at the end of M7 and is recorded in `plans/security-audit.md`.
- **Decided during M7:** a protected path whose spelling goes through a symlink the agent could replace (one in a writable directory, anywhere in its chain) makes the session refuse to start (503), with no opt-out: bubblewrap cannot mount on a link, and srt only protected the link's target.

Starting point: M6's native backend (`crates/pirc-node/src/sandbox/linux.rs`) mounts each existing policy path by its `readAllowed`/`writeAllowed` verdict and proxies HTTP/CONNECT only. Its module documentation lists what it does not enforce yet: missing deny paths (no stubs, so an absent `.pirc`, `.git/hooks` or `.git/config` can be created), symlinked spellings, the mandatory deny scan, rules under `/proc` and `/dev`, uid 0, SOCKS5 (ssh, ftp, rsync), resolved-address checks; `allowLocalBinding` and `allowUnixSockets` have no effect on Linux. Denied domains are already checked by its proxy. The M6 review fixes added: every directory between a writable root and a path the agent may not write is a mount point, so protected paths cannot be renamed away (security audit S7; srt still has the hole); per-session (64) and node-wide (512) caps on proxy connections, which share the node's fd table, with the soft `RLIMIT_NOFILE` raised to the hard limit at start-up.

- [x] Linux: port srt's filesystem argument generation (symlinks, missing paths, `/` expansion, mandatory deny scan; Apache-2.0 notice) on spike C's base; read denials, write allowlist, read-only `.pirc/`, `.git/hooks`, `.git/config`, rc files; `--cap-drop ALL` and the uid-0 and missing-`CAP_SETFCAP` cases; the network proxy with SOCKS5, denied domains, local binding and runtime approval; no seccomp, as today (`allowAllUnixSockets`).
- [x] macOS: SBPL generation and the same proxy; test on a macOS node.
- [x] Port `sandbox-policy.test.ts`, `sandbox.integration`, `sandbox-srt.integration`; add escape tests (rename-style bypasses are covered for existing paths: extend them to missing paths and symlinked ancestors), and one real `pirc-node agent` start under the native backend (CI runs only the fake srt).
- [x] Panel git off the host's trust (security audit S8): run it inside the sandbox, or with config the agent cannot write, so repository filters cannot run as the node account.
- [x] PTY master opened `O_CLOEXEC` atomically (security audit S9).
- [x] Harden `pirc-node ptc-guest` (security audit S6): `PR_SET_NO_NEW_PRIVS`, a seccomp filter for stdio, memory, futex, clock and exit, `RLIMIT_AS`/`RLIMIT_NOFILE`, inherited fds closed.

**Gate:** a dedicated security review (recorded under `plans/security-audit.md` or a new audit) before any release.

Done 2026-10-12. `pirc-node` sandboxes agents natively on Linux (bubblewrap, `sandbox/linux/{plan,scan,caps,args,status}.rs`) and macOS (`sandbox-exec` with srt's SBPL, `sandbox/macos/`), both behind the shared proxy (`sandbox/proxy/`: srt's mux of HTTP and SOCKS5 on one listener, its per-session token, the resolved-address guard); `PIRC_SANDBOX_SRT` stays the development stand-in. Ported code names its srt 0.0.78 source (`crates/pirc-node/NOTICE`). The Git panel runs git through `Sandbox::prepare_readonly` (read policy, temp dir only, no network; 503 when the sandbox is unavailable or fails), panel PTYs open their master `O_CLOEXEC` atomically (`terminals/pty.rs`, rustix and process-wrap), and `ptc-guest` hardens itself before reading its script (`pirc_ptc::harden`: fds closed, rlimits, `no_new_privs`, a measured seccomp allowlist answering EPERM). Tests: golden SBPL profiles recorded from srt (`tests/fixtures/sbpl`, plus snapshots of pirc's production profiles), bubblewrap escape, network, read-only, panel-git (with Git LFS), ssh-agent and real-agent tests on Linux, the same kinds on m3air (macOS 26.5), uid 0 under `unshare -r`, rootless podman cases in a new `sandbox-podman` CI job (not run locally: no podman here), guest-hardening tests that fail without the filter. Real host root (`#[ignore]`d; the target directory must be reachable by a uid 0 without capabilities, so not below a 0700 home or in `/tmp`): `sudo -E env "PATH=$PATH" CARGO_TARGET_DIR=/var/tmp/pirc-root-target cargo test -p pirc-node --test sandbox_linux_uid0 -- --ignored host_root_sandboxes` and the same with `capsh --drop=cap_setfcap -- -c '…host_root_without'`; a first run from the home-directory build failed only on that reachability, which the tests now check and explain. Every conformance suite passes unchanged. Reviewed in two rounds through Linux filesystem, network and hardening, correctness and macOS lenses (findings and resolutions in `plans/security-audit.md`, "M7 security gate"). Release sizes: `pirc-gateway` 11.84 MiB, `pirc-node` 16.92 MiB. New dependencies: `seccompiler` (guest filter), `rustix` (PTY master; already linked through `pty-process`), `process-wrap` (setsid without unsafe code), nix `net` (`getifaddrs` for the address guard).

- Beyond srt (deliberate): protected paths cannot be renamed away (S7 pinning, extended to placeholders and worktree `.git` files); the symlink refusal above; missing read denies get hidden placeholders; only placeholders the node recorded (`<state>/sandbox/placeholders`, swept at start) are ever removed, and directory placeholders are shared between concurrent sessions; the host's name-service sockets (nscd, resolved, sssd, avahi) and the node's `/tmp/ssh-*` agent directories are hidden on Linux; session temp dirs live in a node-private parent (`<TMPDIR>/pirc-n-*`) hidden on Linux and write-denied on macOS; macOS denies also hold through symlink-resolved spellings and every link of a chain (`SessionPolicy::linked_denies`, never serialized into srt settings), SBPL strings are escaped as Seatbelt reads them, the read-only profile drops srt's default write paths; the proxy ignores allowlist entries srt's schema refuses, evicts the oldest unauthenticated client past 64 waiting, and runs at most 8 DNS lookups per session.
- Port gaps: one proxied HTTP request per connection, `https://` absolute-form requests refused; Linux `GIT_SSH_COMMAND` uses `pirc-node sandbox-bridge connect` instead of socat; macOS git over ssh fails as with srt (`nc -X 5` has no auth); no violation monitors or Java proxy jar; glob spellings in policy paths are literal on Linux (a warning, no placeholder); Git LFS works in the Git panel (`lfs.storage` in its temp dir, git 2.31 or later), other required filters that write into the repository (git-annex) answer 400.
- Accepted gaps (also srt's, documented in `sandbox/linux/plan.rs`): mounts are by path, so a link retargeted or a hard link made between planning and bubblewrap's start is followed; a host-side replace of a protected file detaches its mount in running sandboxes (S10, accepted by the user); `/tmp/ssh-*` directories created after a session started are visible to it; other visible host daemon sockets are not filtered on Linux (no seccomp, `allowAllUnixSockets` as before); the srt stand-in keeps TS's gaps (name-service sockets, its proxy sockets in `TMPDIR`, macOS temp siblings, with a warning).
- Found along the way and left: `pirc_policy::tests::guard_refuses_private_reads_and_protected_writes` fails on macOS (`/etc` is `/private/etc`; untouched by M7); quickjs-ng asserts in `JS_FreeRuntime` at guest exit after an out-of-memory script (after `done`); the TS-baseline transcript `agent_ptc_unawaited` failed once under load (TS's race between cancel and start); `bun run test` and `test:compiled` still stop at the 24 and 4 tests that need `/bin/bash` on NixOS.

### M8 Native browser

- [ ] CDP client: persistent per-workspace profile, tabs per session, snapshot/ref interaction model from spike A (pinned, embedded injected script in an isolated world; child frames merged with per-frame refs as Playwright does), host guard (`browser-hosts.ts`) via the `Fetch` domain, screencast live view with backpressure, input forwarding, handoff lease, extraction, ffmpeg recording and chunked upload.
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

- None open; the chat role's selection was decided before M6.
