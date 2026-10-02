# Sandbox and browser (per node)

Both are node-side concerns: the node starts every agent inside an OS sandbox, and refuses to start one when it cannot; it also hands its agents a Chromium it owns. Neither involves the gateway.

## The agent sandbox (srt)

Each `pirc-node agent` or `pirc-chat agent` process runs under [srt](https://github.com/anthropic-experimental/sandbox-runtime) (Anthropic's sandbox-runtime): Seatbelt on macOS, bubblewrap plus a seccomp filter on Linux, with a filtering network proxy on both. Everything the agent starts (tools, `bash`, `code` scripts, hooks, teammates, subagents) is inside. Side-panel terminals are **not**.

### srt

`pirc-node` and `pirc-chat` carry srt `0.0.78` themselves (`pirc-node srt …`), including the static seccomp helper Linux needs, which the node writes to `$PIRC_STATE_DIR/sandbox/bin/`. What the host must still provide:

| Platform            | Needs                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nix package / NixOS | Nothing: `nix/sandbox-runtime.nix` builds srt with its dependencies, and the `pirc-chat`/`pirc-node` wrappers point `PIRC_SANDBOX_SRT` at it.                        |
| Other Linux         | `bubblewrap`, `socat` and `ripgrep` from the distribution, and unprivileged user namespaces (Ubuntu 24.04: `sysctl kernel.apparmor_restrict_unprivileged_userns=0`). |
| macOS               | Nothing: Seatbelt (`sandbox-exec`) is part of macOS.                                                                                                                 |

The sandbox is mandatory and cannot be turned off. The node probes srt at start-up (the log says `agent sandbox ready` or why not) and again before starting an agent while the last probe failed. When srt cannot sandbox on the host, **no agent starts**: sending a prompt fails with the reason. `PIRC_SANDBOX=off` makes the node refuse to start, and `"enabled"` in the `sandbox` settings is ignored with a warning.

| Variable           | Default      | Meaning                                                               |
| ------------------ | ------------ | --------------------------------------------------------------------- |
| `PIRC_SANDBOX_SRT` | the built-in | Path to an external srt executable, used instead of the built-in one. |

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
- `allowUnixSockets` (macOS): extra sockets, e.g. an `ssh-agent` or the Nix daemon. On Linux, Unix sockets are allowed wholesale because seccomp cannot filter them by path; instead the sockets that hand out the host (Docker, containerd, Podman, libvirt, LXD/Incus, the D-Bus system bus, systemd, the user's bus, gpg and keyring agents, `SSH_AUTH_SOCK`; `LINUX_HOST_SOCKETS` in `sandbox-policy.ts`) are hidden from the sandbox. Do not put the node account in the `docker` group: any socket it can reach and the list misses is a way out.
- `denyRead` **must** include the directory holding the node's environment file (the one with `PIRC_NODE_TOKEN`) whenever that file is outside `PIRC_STATE_DIR`. On NixOS the token arrives as a systemd credential and the module handles it.
- `allowRead` re-opens a denied path; `denyWrite` closes a writable one. `allowGitConfig` lets `git remote add` write `.git/config` (and with it hooks paths), off by default.
- An invalid `sandbox` object leaves the defaults in force and shows a warning in every session.
- Credential stores and the node's own state stay unwritable even inside a writable path (a workspace holding `PIRC_STATE_DIR`, `~` in `allowedPaths`). A workspace that contains, or sits inside, the node's state or a credential store cannot be added.

### What it does not cover

`web_fetch`, the `browser_*` tools and `web_search` run in the node's browser or on the gateway, outside the sandbox. A hostile node account or host is out of scope; the sandbox limits an agent, it does not make the machine safe from the person who configured it.

## The agents' browser

A node gives its agents one Chromium per workspace through playwright-core, with a persistent profile under `$PIRC_STATE_DIR/browser/` (a login made once serves every session in that workspace). The web and Android side panels show a live screencast, let you take over, and record videos to `<workspace>/.pirc/recordings/`.

| Variable                     | Default                                                     | Meaning                                                                                                     |
| ---------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PIRC_BROWSER`               | `true`                                                      | Enable the browser (unavailable when none is found).                                                        |
| `PIRC_BROWSER_EXECUTABLE`    | `chromium`/`google-chrome`… on `PATH`, else `/Applications` | Chromium or Chrome executable.                                                                              |
| `PIRC_FFMPEG`                | `ffmpeg`                                                    | ffmpeg with libvpx, for recordings.                                                                         |
| `PIRC_BROWSER_VIEWPORT`      | `1280x800`                                                  | Viewport.                                                                                                   |
| `PIRC_BROWSER_IDLE_MS`       | 30 min                                                      | Idle time before a session's tabs close (the profile stays).                                                |
| `PIRC_BROWSER_PROFILES_DIR`  | `$PIRC_STATE_DIR/browser`                                   | Profile location.                                                                                           |
| `PIRC_PLAYWRIGHT_CORE`       | bundled                                                     | On-disk playwright-core directory; the Nix wrapper sets it.                                                 |
| `PIRC_BROWSER_ALLOW_PRIVATE` | —                                                           | Private/local hosts the browser may reach anyway: host names, `*.suffix`, IPs, CIDR ranges, or `*` for all. |
| `PIRC_BROWSER_BLOCK_HOSTS`   | —                                                           | The gateway's public host names (e.g. its `PIRC_ALLOWED_HOSTS`), refused like the `PIRC_DAEMON_URL` host.   |

- Install Chromium (or Chrome) and ffmpeg on the node. The NixOS module does this through `services.pirc.browser.{enable,package,ffmpeg}` (defaults `pkgs.chromium`, `pkgs.ffmpeg-headless`).
- Pages load with the node account's network access and the profile's logins, but only from public hosts. Before a navigation, and for every request and WebSocket a page makes, the host is resolved and refused when it is or resolves to loopback, RFC 1918, carrier-grade NAT (`100.64.0.0/10`), link-local (including `169.254.169.254` cloud metadata), IPv6 unique-local/link-local, multicast or reserved addresses, a `localhost`/`.local`/`.internal`/`.home.arpa` name, or the gateway host (from `PIRC_DAEMON_URL`, plus `PIRC_BROWSER_BLOCK_HOSTS`: set it to the gateway's public host names when the node connects through a different address). Allow exceptions with `PIRC_BROWSER_ALLOW_PRIVATE` (e.g. `localhost,192.168.1.0/24` for a dev server or NAS); the gateway host stays blocked even with `*` unless named explicitly. Redirect hops are checked after the fact: a page that lands on a blocked host is left before the agent reads it. Chromium resolves names itself, so DNS rebinding is narrowed, not closed; service workers are disabled so they cannot bypass the check.
- **Never log into the pirc web UI inside an agent's browser** (for example during a `browser_handoff`): the profile keeps the cookies, and a later agent could drive the UI with them.
- Taking over from the side panel requires holding session control.
- `features.browser.enabled: false` in the agent config hides the tools without disabling the node's browser; `PIRC_BROWSER=false` disables both.
- Headless Linux hosts need the usual Chromium runtime libraries; under the NixOS module's `PrivateDevices=true` hardening, Chromium runs without GPU, which is fine for headless use.
