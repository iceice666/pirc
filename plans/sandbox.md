# OS sandbox for agent processes

Status (2026-10-02): option C built and tested on macOS; mandatory and fail-closed, with srt built into the node executables; not yet run on a real NixOS node. The investigation below is kept as written; "Decisions" and "As built" come first. Paths are relative to `apps/gateway/src/` unless noted.

## Decisions (user, 2026-09-30)

1. **Option C**: sandbox the whole agent process from the node, with a node-side escape hatch.
2. **Reads** open by default, with only sensitive paths blocked.
3. **Network**: a built-in list of common hosts, plus an allowlist, plus approval at run time.
4. **srt** comes from our own derivation, pinned to the latest release.
5. ~~**No sandbox** available: run anyway, with a visible warning.~~ Superseded 2026-10-02 (security audit H1): the sandbox is **mandatory on pirc-node and pirc-chat** (chat agents still have `bash`), with no way to turn it off; without a working sandbox no agent starts.
6. **Also**: fix the independent issues listed below.
7. (2026-10-02) **srt is built into** `pirc-node` / `pirc-chat` (`pirc-node srt …`). An external srt named by `PIRC_SANDBOX_SRT` takes precedence; the Nix package keeps pointing it at `nix/sandbox-runtime.nix`. `srt` on `PATH` is no longer looked up.

## As built

- **Policy** (`sandbox-policy.ts`), shared by node and agent:
  - `sessionPolicy()` builds a session's rules:
    - `denyRead` (the node's private dirs, `SENSITIVE_HOME_PATHS`, configured entries);
    - `allowRead` carve-outs (the workspace or chat directory, the session dir, workspace memory, the inference socket's dir);
    - `allowWrite` (the workspace, the node's `allowedPaths`, the session dir, workspace memory, a per-session tmp dir, `/tmp`, existing `CACHE_HOME_PATHS`, configured entries);
    - `denyWrite` (`<workspace>/.pirc`, configured entries);
    - network: `DEFAULT_ALLOWED_DOMAINS` plus configured domains, localhost binding, and the inference socket.
  - `readAllowed` / `writeAllowed` follow srt's precedence rules: the innermost read rule wins, allow wins a tie, and `denyWrite` always wins.
  - Settings come from `sandbox` in the node's agent `config.json`. A project's config is never read for them.
- **Node** (`node/sandbox.ts`):
  - `NodeSandbox.check()` probes srt (`srt --settings probe -- /bin/sh -c 'exit 0'`) at node start-up, which logs the result. A success holds; a failure is probed again on the next agent start after 30 s.
  - **Fail-closed**: when the probe fails, `prepare()` throws `503 runner_unavailable` ("Agents on this node must run in the sandbox …"), so the prompt fails with the reason. `PIRC_SANDBOX=off` makes `loadNodeConfig` throw; `sandbox.enabled` in config.json is dropped with a warning; the NixOS option `services.pirc.sandbox.enable` is a removed option.
  - **Built-in srt** (`node/srt.ts`): `@anthropic-ai/sandbox-runtime@0.0.78` is a dependency, patched (`patches/`) only so `bun build --compile` can bundle its manifest; `pirc-node srt` imports its CLI. On Linux the static `apply-seccomp` helpers (x64, arm64) are embedded with `with { type: 'file' }`; the node writes the one for its CPU to `<stateDir>/sandbox/bin/` (content-addressed, rewritten when altered), names it in the settings (`seccomp.applyPath`), and the policy makes that dir readable but not writable. bubblewrap, socat and ripgrep still come from the host.
  - `prepare()` writes `<stateDir>/sandbox/<session>.json` and makes a short per-session tmp dir. srt receives that dir as `CLAUDE_CODE_TMPDIR`, which becomes `TMPDIR` inside the sandbox. It is kept short because macOS caps Unix socket paths at 104 bytes and srt puts its mux socket there.
  - `prepare()` returns `srt --settings … --control-fd 3 -- <agent>`.
  - Invalid settings keep the defaults and add a warning.
  - `PIRC_SANDBOX_SRT` names an external srt; otherwise the node runs its own executable's `srt`.
  - **Private state stays unwritable** (audit M10): credential stores and the node's private dirs are in `denyWrite` too. srt has no "deny except", so a private dir inside a writable root is closed entry by entry around the session's own state (`denyWriteAround`); entries the node creates later are not covered, so the node warns about such a layout and refuses to register a workspace that contains or sits inside its state or a credential store.
  - **Linux host sockets** (audit M11): `allowAllUnixSockets` stays (the inference socket), but `LINUX_HOST_SOCKETS` (Docker, containerd, Podman, libvirt, LXD/Incus, D-Bus, systemd, the user bus, gpg/keyring agents) and `SSH_AUTH_SOCK` are added to `denyRead` where they exist.
- **Runner** (`node/runner.ts`):
  - **Spawn**: srt is spawned detached (its own process group; kills go to the group). fd 3 is srt's control pipe.
  - **Agent environment**: `PIRC_SANDBOX=srt|off`, and `PIRC_SANDBOX_POLICY` (the path rules).
  - **Readiness and warnings**: `runner_ready` carries `sandbox: {active, reason}`. Each warning is a `notify` notification, also kept in the snapshot, so web and Android show it in the timeline.
  - **Requests from the agent**: `sandbox_request` with op `network` or `exec` (`sandbox_cancel` withdraws one).
  - **Approvals come from the node**: it opens its own confirm interaction (rpc id prefix `node-sandbox-`), and `answer()` resolves it without telling the agent. Dialogs or cancels the agent emits with that prefix are dropped.
  - **Approved network**: pushes the full srt settings (policy plus approved domains) down the control fd. Approvals last for the rest of the session.
  - **Approved exec**: `runOnHost` runs `bash -c` in the workspace (the cwd must stay inside it), in its own process group, with `withoutSecrets(process.env)`. It has a timeout, keeps 1 MB of output (head and tail), and can be aborted.
  - A runner exists only inside the sandbox; the agent keeps its `unrestricted` / `not_sandboxed` answers only for runs outside a node.
- **Agent**:
  - `agent/sandbox-channel.ts` carries the requests; only the main agent has the channel.
  - `agent/features/sandbox.ts` adds:
    - the tools `sandbox_allow_domains` and `unsandboxed_bash` (the latter holds the workspace write lease);
    - a system prompt section explaining the sandbox.
  - `PathGuard` (`agent/sandbox.ts`) applies the node's policy: always its read rules, and its write rules when `PIRC_SANDBOX=srt`. Unsandboxed, the configured `allowedPaths` still decide writes. Outside a node, `defaultPathPolicy` applies: credential stores are denied.
  - Error messages name the resolved path. `realResolve` resolves through a directory it cannot see into by resolving the parent, so `/var` becomes `/private/var` inside the sandbox too.
- **Nix**:
  - `nix/sandbox-runtime.nix`: srt 0.0.78 built from git with its lockfile. The static Linux seccomp helpers come from the npm tarball, because upstream builds them in CI only.
  - `nix/package.nix` installs the binary to `libexec/` behind a `makeBinaryWrapper` that sets `PIRC_SANDBOX_SRT` and `PIRC_PLAYWRIGHT_CORE`.
- **NixOS module**:
  - `services.pirc.sandbox.enable` turns the sandbox on or off.
  - The gateway runs as `gatewayUser` (default `pirc-gateway`), in `/var/lib/pirc/daemon`, which is 0700. The tmpfiles `Z` rule hands an existing directory over to that account.
  - The token file lives in the daemon dir. A root `ExecStartPre` creates it, or moves the old one. The node receives it through `LoadCredential`, and `CREDENTIALS_DIRECTORY` is added to its private dirs.
  - `environmentFile` goes to the gateway only; `localNode.environmentFile` is the node's.
  - The state root is 0711.
- **Independent fixes**:
  - **Panel git** (`node/inspect.ts`): now runs with `withoutSecrets`.
  - **Chromium and ffmpeg** (`node/browser.ts`): `withoutSecrets` too.
  - **`SECRET_ENV`**: now matches every `PIRC_*TOKEN*/SECRET*/KEY*/PASSWORD*`, plus `EXA_API_KEY`. User tokens such as `GITHUB_TOKEN` are still kept.
  - **Browser in Nix builds**: fixed by shipping playwright-core on disk (`PIRC_PLAYWRIGHT_CORE`, `BrowserSettings.playwrightCore`). Patching `require` paths was not enough: `browsers.json`, a wasm codec and `libPath()` assets are read the same way.
- **PTC and auto mode**:
  - Auto mode still classifies only `bash` and `background_task`. A `code` script's own `Bun.spawn` or `fs` calls are not classified.
  - Under the sandbox they are confined like any shell command. Without a sandbox they are not; that gap stays and is documented here.
- **Tests**:
  - `test/sandbox-policy.test.ts`: the policy rules.
  - `test/sandbox.integration.test.ts`, with a fake srt (`test/fixtures/fake-srt.sh`), covers:
    - the unconfined warning (including the snapshot);
    - the settings file;
    - network approve and decline, and the control-fd update;
    - exec approve and decline (the token is not leaked; the cwd is confined);
    - that forged dialogs are ignored.
  - `test/sandbox-srt.integration.test.ts` runs a real `pirc agent` under the real srt. It needs `PIRC_TEST_SRT` or `srt` on PATH, and is skipped otherwise. It checks that:
    - a state read is refused (bash and `read`);
    - a workspace write succeeds and a `$HOME` write is refused;
    - a host not on the list is blocked;
    - `code` (IPC) and a PTY work;
    - `unsandboxed_bash` runs after approval.
  - `agent-core` covers PathGuard with and without a node policy.
- **Teammates and subagents** share the parent's sandbox and have the same two tools. A child's request goes over the team channel (`team_call` `sandbox_request`) to its parent, which relays it to the node, or up to its own parent (`relaySandboxRequest`). The reason is prefixed `[asked by <name>]`, so the human sees who asks. Error codes such as `denied` travel as values, because the team channel only carries messages. Covered by `agent-subagent.test.ts`.
- **Lasting badge**: the snapshot carries `sandbox: {active, reason} | null` (null with no runner). Web shows a "Not sandboxed" chip in the session title block, with the reason as its tooltip. Android shows the same chip under the top bar; tapping it shows the reason. `runner_ready` already makes both clients fetch a new snapshot.
- **Checked by hand**: on macOS, srt's `allowUnixSockets` is required, and enough, for Bun `fetch({unix})`, which is how the agent reaches the inference socket.

### Follow-ups

- **Real NixOS node**: run it there. To confirm (未確認):
  - bubblewrap under the unit's hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateDevices`);
  - the tmpfiles hand-over of an existing `/var/lib/pirc/daemon`;
  - `apiKeyFile` ownership after the gateway moves to `pirc-gateway`.
- **Linux sockets**: Unix sockets are allowed wholesale there (`allowAllUnixSockets`), because seccomp cannot filter by path and the agent needs the inference socket. Known host sockets are hidden (M11), but any other socket the account can reach is open. Moving inference off a Unix socket (or bind-mounting only it) would close this.
- **Workspace memory**: the dir is writable as a whole, so a session could append to another repository's ledger.
- **Approvals**: they last only for the session. There is no "always allow for this workspace" yet.
- **launchd nodes** (m5pro, m3air): their env file lives outside `PIRC_STATE_DIR`. Until `sandbox.filesystem.denyRead` includes `~/.local/pirc-node`, an agent there can still read `agent.env`. A hand-copied binary now carries its own srt.
- **Built-in srt on Linux**: not yet run on a real Linux host (bubblewrap finding the extracted `apply-seccomp` inside the namespace, 未確認).

## Why

`PathGuard` (`agent/sandbox.ts:27-31`) only limits the file tools. Every other way the agent runs code ignores it. In practice:

- `cat` or `code` can read what `read` refuses. The session that wrote this plan read its own blocked `SKILL.md` with `cat`.
- On the macOS nodes (launchd `dev.pirc.node-agent`, running as the login user, `DEPLOY.md`), bash can read:
  - `~/.local/pirc-node/agent.env`, which holds `PIRC_NODE_TOKEN`;
  - the node SQLite, and every session's JSONL under `state/sessions/`;
  - the browser profiles, with their cookies and logins (`config.ts:311-313`);
  - `~/.ssh` and everything else in home.
- On NixOS, the gateway and node run as the same `User` (`nix/module.nix:146`, `:558`, `:577`). The node's bash can therefore read:
  - the shared token file (`module.nix:63`);
  - the daemon's state: `vapid.json`, `backends/settings.json` with OAuth credentials and web-managed keys, and `gateway.sqlite`;
  - the shared `EnvironmentFile`. It holds provider keys and `EXA_API_KEY` (`module.nix:333`), and `withoutSecrets` (`node/secrets.ts:2`) only strips `PIRC_NODE_TOKEN(S)` and `PIRC_*SECRET*`.
- Neither the write lease nor auto mode is a boundary. The lease is advisory. Auto mode gates `bash` and `background_task` only (`auto-mode/index.ts:117-133`), so `code` (PTC, `ptc/code-tool.ts:83`) and hooks (`hooks.ts:41`) are never classified.

## Where agent code runs

```
pirc gateway ── keys, vapid, OAuth, Exa, provider network
  ⇅ WS (node token)
pirc node ── node token, SQLite, inference Unix socket, Chromium, ffmpeg, panel git, user PTYs
  └─ pirc agent (node/runner.ts:66; env = withoutSecrets(process.env), stdio JSONL RPC)
       ├─ bash tool            agent/tools/bash.ts:38
       ├─ background_task      agent/features/background/manager.ts:151,158 (PTY via Bun.Terminal)
       ├─ hooks                agent/hooks.ts:41
       ├─ code (ptc-worker)    agent/ptc/code-tool.ts:83 (Bun IPC; runs model-written TS)
       ├─ git (memory)         agent/features/memory/workspace.ts:85
       └─ team/subagents       agent/features/team/team.ts:182 → the same five again
```

- The agent itself needs **no network** in node mode:
  - Model calls go over the Unix socket `<stateDir>/i-*/socket` (`agent/providers/remote.ts:45`, `node/inference.ts:160-165`).
  - `web_search` goes over stdio to the node and then the daemon (`agent/features/web-search.ts`).
  - `web_fetch` and `browser_*` go over stdio to the node's Chromium (`agent/browser-channel.ts:81`).
- Only shell workloads (npm, git fetch, curl, nix) need outbound network.
- The node already lets you replace the agent command: `PIRC_AGENT_COMMAND` / `PIRC_AGENT_ARGS` (`config.ts:172-176`, `node/runner.ts:58-66`). team and ptc-worker children use `selfCommand()`, so they stay inside whatever wraps the parent.

## Candidate: Anthropic sandbox-runtime (`srt`)

Source: https://github.com/anthropic-experimental/sandbox-runtime (README read at npm 0.0.78, 2026-09-30).

- **Mechanism**: `sandbox-exec` with a generated Seatbelt profile on macOS; bubblewrap plus a seccomp filter on Linux. Network goes through host-side HTTP and SOCKS5 proxies with a domain allow/deny list. On Linux the network namespace is removed entirely.
- **Filesystem model**:
  - Reads are open by default; `denyRead` areas can be re-opened with `allowRead`, and allow wins.
  - Writes are closed by default; `allowWrite` opens them and `denyWrite` wins.
  - Some paths can never be written: shell rc files, `.gitconfig`, `.git/hooks`, `.git/config`, `.vscode`, …
  - Rule paths go through `realpath` (`dist/sandbox/sandbox-utils.js:338-443`). So Nix store links are judged where they land, just as in our `PathGuard`.
- **Network**:
  - Denied unless a domain is listed; ports are optional.
  - Before dialing, the resolved address is checked, which blocks loopback, link-local, metadata and the host's own addresses.
  - Unix sockets are blocked by default. macOS allowlists them by path (`allowUnixSockets`); Linux has only all-or-nothing.
- **API**:
  - Library: `SandboxManager.initialize(config, askCallback?)` / `wrapWithSandbox(cmd, shell, perCallConfig, signal, {commandId})` / `annotateStderrWithSandboxFailures` / `cleanupAfterCommand` / `reset`. `wrapWithSandboxArgv` also exists.
  - CLI: `srt --settings file -- cmd`. `--control-fd` lets you swap the network lists live; filesystem rules are fixed at wrap time.
- **Maturity**: "Beta Research Preview", Apache-2.0. 74 releases in about 11 months, the latest on the day of this investigation. APIs may change. Knows about Bun (`dist/cli.js:74-92`).
- **Dependencies**:
  - macOS: ripgrep.
  - Linux: bubblewrap, socat, ripgrep, plus the bundled static `vendor/seccomp/{x64,arm64}` binaries. The vendor directory is 6.9 MB in total and includes a JVM proxy agent jar.
  - Ubuntu 24.04+ needs `kernel.apparmor_restrict_unprivileged_userns=0`.
- **Nix**: nixpkgs has `sandbox-runtime` at 0.0.52 (aarch64-darwin eval), 26 releases behind npm.

Tested on m5pro (macOS 25.5):

```
sandbox-exec -p '(allow default)(deny file-read* (subpath "/tmp/srt/deny"))' \
  sandbox-exec -p '(allow default)' /bin/ls /tmp/srt/deny
→ sandbox-exec: sandbox_apply: Operation not permitted (exit 71)
```

**macOS sandboxes cannot nest.** A per-command sandbox cannot run inside a sandboxed agent. We have to pick one layer.

The alternative is Codex CLI's Rust sandbox (Seatbelt / Landlock + seccomp). It is not a TS library, and we would have to port its profiles ourselves. That is exactly the kind of work that brought us here, so it is not pursued. The Codex details were not re-verified in this session (未確認).

## Options

### A. Sandbox the whole agent process (node-side, one choke point)

The node wraps `runner.ts:66` with srt. The policy is built per session: workspace, session dir, workspace-memory dir, the inference socket and the tmp dir.

- **Pros**:
  - One place covers bash, background, PTY, hooks, `code`, memory git and team/subagent children, including future spawn sites.
  - The file tools and the shell see the same boundary, so `PathGuard` stops being the security layer and becomes a UX layer.
  - The agent process itself can no longer read the node's state.
- **Cons**:
  - The policy is fixed at spawn. Network lists can change live (`--control-fd` or library `updateConfig`); filesystem rules cannot.
  - A per-command escape hatch has to run **outside** the agent, because of the nesting limit.
  - Violations are attributed to the whole session, not to a single command.

### B. Sandbox each command (Claude Code's model)

Wrap the spawns at `bash.ts:38`, `manager.ts:151/158`, `hooks.ts:41`, `code-tool.ts:83`, and optionally `workspace.ts:85`.

- **Pros**:
  - Per-command policy and violation annotation (`commandId`).
  - A simple "run this one unsandboxed after approval" path.
- **Cons**:
  - Five or six sites, and every new spawn site must remember to wrap.
  - The agent process itself stays unconfined: file tools still read with the user's full rights, so `PathGuard` stays load-bearing.
  - srt's proxies and state live in each agent process. That is one proxy pair per session, and team children spawn their own.

### C. A plus a node-side escape hatch (recommended to evaluate first)

A, plus a new `exec_request` on stdio, shaped like `write_lease_request` and `browser_request`. The node:

- asks the human, the way `browser_handoff` and danger actions do today;
- runs the command outside the sandbox with `withoutSecrets` env;
- streams the output back.

This covers `nix build`, `just switch` (still subject to the existing rule that the user runs or approves it), git over SSH and anything else that cannot work confined. The network allowlist can grow at runtime through the same approval path ("allow registry.npmjs.org for this session?"), pushed with `--control-fd`.

## Proposed default policy (for A/C)

|              | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| read         | Open, except `denyRead`:<ul><li>the node's `PIRC_STATE_DIR`, then `allowRead` back only this session's dir and this workspace's memory dir;</li><li>the directory holding `agent.env` / the token file;</li><li>the daemon state dir when co-located;</li><li>the browser profiles;</li><li>`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.config/sops`, `~/Library/Keychains`;</li><li>other workspaces.</li></ul> |
| write        | The workspace, `allowedPaths`, this session's dir (session JSONL and team dir), this workspace's memory dir, the per-user `$TMPDIR` (background logs and PTC scripts live there, `manager.ts:131`, `code-tool.ts:53`) and build caches as configured. `denyWrite`: `<ws>/.pirc`, the skill roots, plus srt's mandatory list.                                                                                                         |
| unix sockets | The inference socket. Opt-in per config: `SSH_AUTH_SOCK`, the nix daemon socket.                                                                                                                                                                                                                                                                                                                                                     |
| network      | A per-user and per-workspace allowlist, with approval to extend it at runtime. Localhost binding is on, so dev servers work; the node's Chromium runs outside and can still reach them.                                                                                                                                                                                                                                              |
| pty          | `allowPty` (the profile generator has it, `macos-sandbox-utils.js:674`) for `background_task tty:true`.                                                                                                                                                                                                                                                                                                                              |

`PathGuard` would switch to the same model: reads open minus `denyRead`, writes limited to `allowWrite`. Both would be generated from one config so they cannot drift. This also removes the need for the `skillReadPaths` symlink walk added in 630917c.

## Holes the sandbox does not close

Documented so nobody treats the sandbox as the whole answer:

- `web_fetch` and `browser_*` run in the node's Chromium; `web_search` runs on the daemon. They sit outside the sandbox's network filter and remain exfiltration channels. Tracked with the taint work in `plans/assistant.md`.
- Anything sent to the model provider.
- Allowlisted domains: an allowed `github.com` lets the agent push anywhere.
- Hooks come from config the user writes. Sandboxing them (A does) may break hooks that expect full access.

## Independent fixes worth doing regardless

1. `node/inspect.ts:51`: the panel git spawns with the unfiltered `process.env`, so `PIRC_NODE_TOKEN` reaches git. That git runs in an agent-writable repo. `core.fsmonitor=false` is already set (`:39`). Whether git config such as filter drivers can still run commands during `status` is 未確認, but the env should use `withoutSecrets` in any case.
2. `withoutSecrets` is a denylist. Turn it into an allowlist, or at least strip `EXA_API_KEY`, `PIRC_VAPID_*` and provider key vars.
3. NixOS module:
   - run the gateway and node as different users, or hand the node its token through `LoadCredential=` rather than a file in the shared state dir;
   - stop giving the node the gateway's `EnvironmentFile`.
4. Auto mode does not classify `code`. At least document this; ideally the PTC worker's own bash goes through the gate. `agent-auto-mode.test.ts:242` covers PTC-issued `bash` tool calls, but not `Bun.spawn` inside the script.
5. Unrelated but found here: the Nix-built `pirc` fails to start the browser. The error is `Cannot find module '/nix/var/nix/b/…/source/node_modules/.bun/playwright-core@1.63.0/…/package.json'`: the compiled binary still points at the build sandbox path. The same class of problem would hit srt's `vendor/` files if srt were bundled into `bun build --compile`, so srt should be packaged as its own derivation and invoked as a CLI (option A/C) or loaded from a store path.

## Open decisions for the user

1. Choose **A/C** (whole agent, node-side escape hatch) or **B** (per command, like Claude Code).
2. Read policy: open with a denylist (proposed), or workspace-only (`denyRead: [$HOME], allowRead: [workspace]`), which would also block reading dotfiles and other repos.
3. Network default: an allowlist plus runtime approval (proposed), a curated default list (GitHub, npm, PyPI, crates, cache.nixos.org), or open with only metadata and loopback denied.
4. srt source: nixpkgs 0.0.52, or our own derivation pinned to npm latest (preferred, given the release pace).
5. What happens when the sandbox is unavailable (Linux without userns, missing bwrap): refuse to start agents, or run unconfined with a visible warning.

## Validation plan (once decided)

- Unit: the policy builder (paths per session, realpath of Nix links, deny/allow precedence) and `PathGuard` parity with it.
- Integration: `gateway-agent.integration.test.ts` with a wrapped `agentCommand` (`test/helpers.ts:34`). Cases:
  - `cat` of the state dir is denied;
  - a workspace write succeeds;
  - inference over the socket still works;
  - `background_task tty:true` still works;
  - the ptc-worker IPC still works;
  - a team child inherits the sandbox;
  - an escape-hatch request needs approval.
- Manual: m5pro (macOS) and a NixOS node, covering git over HTTPS, `nix build` through the escape hatch, a dev server reached by the node's browser, and `bun test` inside the sandbox.
