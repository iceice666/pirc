# Sandbox and browser (per node)

Both are node-side concerns: the node starts every agent inside an OS sandbox when it can, and hands its agents a Chromium it owns. Neither involves the gateway.

## The agent sandbox (srt)

Each `pirc agent` process runs under [srt](https://github.com/anthropic-experimental/sandbox-runtime) (Anthropic's sandbox-runtime): Seatbelt on macOS, bubblewrap plus a seccomp filter on Linux, with a filtering network proxy on both. Everything the agent starts (tools, `bash`, `code` scripts, hooks, teammates, subagents) is inside. Side-panel terminals are **not**.

### Installing srt

| Platform            | How                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nix package / NixOS | Nothing to do: `nix/sandbox-runtime.nix` builds srt (pinned to npm `0.0.78`, because nixpkgs trails upstream) and the `pirc` wrapper sets `PIRC_SANDBOX_SRT` to it.                                                                                            |
| Other Linux         | `npm install -g @anthropic-ai/sandbox-runtime` (an npm package: it needs Node.js), plus `bubblewrap`, `socat` and `ripgrep` from the distribution. Needs unprivileged user namespaces (Ubuntu 24.04: `sysctl kernel.apparmor_restrict_unprivileged_userns=0`). |
| macOS without Nix   | `npm install -g @anthropic-ai/sandbox-runtime` (needs Node.js) plus `ripgrep`. Seatbelt (`sandbox-exec`) is built into macOS.                                                                                                                                  |

The node looks for `srt` on its `PATH`, or where `PIRC_SANDBOX_SRT` points. It probes srt once at start-up; if the probe fails, agents run **unconfined**, every session opens with a warning and its header shows a "Not sandboxed" badge. Nothing refuses to run.

| Variable           | Default         | Meaning                                                                                  |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------- |
| `PIRC_SANDBOX`     | on              | `off` disables the sandbox on this node (NixOS: `services.pirc.sandbox.enable = false`). |
| `PIRC_SANDBOX_SRT` | `srt` on `PATH` | Path to the srt executable.                                                              |

### What the policy is

- **Reads**: everywhere, except credential stores under the account's home (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.config/sops`, keychains, browser profiles, …; the full list is `SENSITIVE_HOME_PATHS` in `apps/gateway/src/sandbox-policy.ts`) and the node's own state (`PIRC_STATE_DIR`, minus the session's own directory and its workspace's memory ledger; the systemd credentials directory on NixOS).
- **Writes**: the workspace (or the chat's directory), the node config's `allowedPaths`, the session's temporary directory, `/tmp`, and common build caches (`~/.cache`, `~/.npm`, `~/.cargo/registry`, `~/go/pkg/mod`, `~/.gradle/caches`, …). `.pirc/` in the workspace, `.git/hooks`, `.git/config` and shell start-up files stay read-only.
- **Network**: only through srt's proxy, to `DEFAULT_ALLOWED_DOMAINS` (GitHub, GitLab, Codeberg, npm, PyPI, crates.io, Go proxy, Nix caches, Maven, RubyGems, …) plus what you add. A host the task needs and the list lacks makes the agent call `sandbox_allow_domains`; the **node** asks you in the session, and an approved host stays allowed for that session.
- **Escape hatch**: for a `nix build`, git over SSH or a system change, the agent calls `unsandboxed_bash`. The node asks you first, then runs the command as the node account, without the node's own secrets.

Both approvals are the node's own dialogs; nothing the agent prints counts as your answer. Teammates' and subagents' requests are relayed through their parent and say who is asking.

### Tuning it

In the node's `$PIRC_CONFIG_DIR/config.json` (never a project's `.pirc/config.json`):

```json
{
  "sandbox": {
    "enabled": true,
    "network": {
      "defaultDomains": true,
      "allowedDomains": ["api.example.com", "*.internal.example.org", "127.0.0.1:8080"],
      "deniedDomains": [],
      "allowLocalBinding": true,
      "allowUnixSockets": []
    },
    "filesystem": {
      "denyRead": ["~/.local/pirc-node"],
      "allowRead": [],
      "allowWrite": [],
      "denyWrite": [],
      "allowGitConfig": false
    }
  }
}
```

- Domains: a host, a `*.` wildcard, `localhost`, or an IPv4 address, each with an optional `:port`. `deniedDomains` wins.
- `allowLocalBinding` lets dev servers listen on localhost.
- `allowUnixSockets` (macOS): extra sockets, e.g. an `ssh-agent` or the Nix daemon. On Linux, Unix sockets are allowed wholesale because seccomp cannot filter them by path.
- `denyRead` **must** include the directory holding the node's environment file (the one with `PIRC_NODE_TOKEN`) whenever that file is outside `PIRC_STATE_DIR`. On NixOS the token arrives as a systemd credential and the module handles it.
- `allowRead` re-opens a denied path; `denyWrite` closes a writable one. `allowGitConfig` lets `git remote add` write `.git/config` (and with it hooks paths), off by default.
- An invalid `sandbox` object leaves the defaults in force and shows a warning in every session.

### What it does not cover

`web_fetch`, the `browser_*` tools and `web_search` run in the node's browser or on the gateway, outside the sandbox. A hostile node account or host is out of scope; the sandbox limits an agent, it does not make the machine safe from the person who configured it.

## The agents' browser

A node gives its agents one Chromium per workspace through playwright-core, with a persistent profile under `$PIRC_STATE_DIR/browser/` (a login made once serves every session in that workspace). The web and Android side panels show a live screencast, let you take over, and record videos to `<workspace>/.pirc/recordings/`.

| Variable                    | Default                                                     | Meaning                                                      |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `PIRC_BROWSER`              | `true`                                                      | Enable the browser (unavailable when none is found).         |
| `PIRC_BROWSER_EXECUTABLE`   | `chromium`/`google-chrome`… on `PATH`, else `/Applications` | Chromium or Chrome executable.                               |
| `PIRC_FFMPEG`               | `ffmpeg`                                                    | ffmpeg with libvpx, for recordings.                          |
| `PIRC_BROWSER_VIEWPORT`     | `1280x800`                                                  | Viewport.                                                    |
| `PIRC_BROWSER_IDLE_MS`      | 30 min                                                      | Idle time before a session's tabs close (the profile stays). |
| `PIRC_BROWSER_PROFILES_DIR` | `$PIRC_STATE_DIR/browser`                                   | Profile location.                                            |
| `PIRC_PLAYWRIGHT_CORE`      | bundled                                                     | On-disk playwright-core directory; the Nix wrapper sets it.  |

- Install Chromium (or Chrome) and ffmpeg on the node. The NixOS module does this through `services.pirc.browser.{enable,package,ffmpeg}` (defaults `pkgs.chromium`, `pkgs.ffmpeg-headless`).
- Pages load with the node account's network access and the profile's logins. Taking over from the side panel requires holding session control.
- `features.browser.enabled: false` in the agent config hides the tools without disabling the node's browser; `PIRC_BROWSER=false` disables both.
- Headless Linux hosts need the usual Chromium runtime libraries; under the NixOS module's `PrivateDevices=true` hardening, Chromium runs without GPU, which is fine for headless use.
