# Sandbox and browser (per node)

Both are node-side concerns: the node starts every agent inside an OS sandbox, and refuses to start one when it cannot; it also hands its agents a Chromium it owns. In the deployed topology neither involves the gateway; see [the opt-in gateway runtime](#opt-in-gateway-agent-runtime-boundaries) for the separate boundaries that runtime adds.

## The agent sandbox (srt)

Each `pirc-node agent` or `pirc-chat agent` process runs under [srt](https://github.com/anthropic-experimental/sandbox-runtime) (Anthropic's sandbox-runtime): Seatbelt on macOS, bubblewrap plus a seccomp filter on Linux, with a filtering network proxy on both. Everything the agent starts (tools, `bash`, `ptc` scripts, hooks, teammates, subagents) is inside. A `ptc` script's interpreter process gets an empty environment and talks only to its agent. Side-panel terminals are **not**.

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
- **Escape hatch**: for a `nix build`, a system change, or git over SSH that is not [set up for the sandbox](#git-and-the-github-cli), the agent calls `unsandboxed_bash`. The node asks you first, then runs the command as the node account, without the node's own secrets.

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

### Git and the GitHub CLI

Without setup, this is what works inside the sandbox:

| What                              | Result         | Why                                                                                                                                                                                                                       |
| --------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| git over HTTPS, public repository | Works          | Goes through srt's proxy; `github.com` is in the default domains.                                                                                                                                                         |
| git over HTTPS, private or push   | No credentials | `~/.git-credentials`, `~/.netrc` and the keychain are unreadable, and `GH_TOKEN`/`GITHUB_TOKEN` are not passed on ([Node](node.md#agent-process)).                                                                        |
| `gh`                              | Does not start | `~/.config/gh` is unreadable. On macOS, its TLS check also needs the system trust service, which the sandbox blocks (`x509: OSStatus -26276`).                                                                            |
| git over SSH                      | Fails          | `~/.ssh` is unreadable. On macOS, srt's own `GIT_SSH_COMMAND` (`nc -X 5`) cannot send the credentials srt's proxy requires: `This proxy requires authentication, and this client did not offer an authentication method`. |

So the agent falls back to `unsandboxed_bash`, and you approve every push. Two setups make it work inside the sandbox: [HTTPS with a token](#https-with-a-token) (recommended) or [SSH with a dedicated key](#ssh-with-a-dedicated-key). Both are `env` entries in the node's `$PIRC_CONFIG_DIR/config.json`, which the agent adds to `bash` and `background_task` (also when called from a `ptc` script), hooks and teammates (not to `unsandboxed_bash`, which runs with the node account's own setup). They apply from the next agent start. Values are literal strings: `~` is not expanded there, except where the SSH command line below expands it itself.

Either way the agent holds the credential: reads are open, so it can read it, and it can use it for everything the credential allows on an allowed host. Use the narrowest credential: a fine-grained personal access token, or deploy keys, limited to the repositories the agent works on.

Tested on macOS with the built-in srt 0.0.78. Not tested on Linux.

#### HTTPS with a token

```json
{
  "env": {
    "GH_TOKEN": "github_pat_…",
    "GH_CONFIG_DIR": "/Users/you/.cache/pirc/gh",
    "SSL_CERT_FILE": "/etc/ssl/cert.pem",
    "GIT_CONFIG_COUNT": "3",
    "GIT_CONFIG_KEY_0": "credential.helper",
    "GIT_CONFIG_VALUE_0": "",
    "GIT_CONFIG_KEY_1": "credential.https://github.com.helper",
    "GIT_CONFIG_VALUE_1": "!gh auth git-credential",
    "GIT_CONFIG_KEY_2": "url.https://github.com/.insteadOf",
    "GIT_CONFIG_VALUE_2": "git@github.com:"
  }
}
```

- `GH_TOKEN`: `gh` uses it instead of `~/.config/gh/hosts.yml`. For a fine-grained token: Contents read/write to push, Pull requests read/write for `gh pr`, Metadata read. To keep it out of `config.json`, put it in the node's environment instead and name it in `PIRC_AGENT_ENV_ALLOW=GH_TOKEN` ([Node](node.md#agent-process)).
- `GH_CONFIG_DIR`: the absolute path (with your home in place of `/Users/you`) of a directory the sandbox may write, outside `~/.config/gh`. It may be empty; create it once (`mkdir -p ~/.cache/pirc/gh`).
- `SSL_CERT_FILE` (macOS only): makes `gh` and other Go programs verify TLS against this bundle, which macOS ships, instead of the system trust service. Other tools honour it too.
- `GIT_CONFIG_*`: git configuration from the environment, so your `~/.gitconfig` (read-only in the sandbox, and shared with you) stays unchanged.
  - Key 0 clears inherited credential helpers. For example, Nix's git enables `osxkeychain`, which cannot reach the keychain and prints `failed to store: -60008`.
  - Key 1 gives git the same token through `gh`.
  - Key 2 rewrites SSH-style GitHub remotes to HTTPS, so existing clones push without `git remote set-url`; that command needs `.git/config`, which is read-only by default.
  - `GIT_CONFIG_COUNT` must equal the number of keys.

Check from a session: `gh auth status`, then `git ls-remote` on a private repository.

#### SSH with a dedicated key

As the node account, outside the sandbox (a side-panel terminal works), with a pirc checkout at hand:

```sh
mkdir -p ~/.local/pirc-ssh ~/.cache/pirc/ssh
chmod 700 ~/.local/pirc-ssh
ssh-keygen -t ed25519 -N '' -C pirc-agent -f ~/.local/pirc-ssh/id_ed25519
cp scripts/sandbox-ssh-proxy.py ~/.local/pirc-ssh/
```

Add `~/.local/pirc-ssh/id_ed25519.pub` to each repository as a deploy key with write access. GitHub accepts a key as a deploy key on one repository only; for several repositories, use a separate machine account. Then:

```json
{
  "env": {
    "GIT_SSH_COMMAND": "ssh -F /dev/null -o ControlMaster=no -o ControlPath=none -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=~/.cache/pirc/ssh/known_hosts -i ~/.local/pirc-ssh/id_ed25519 -o ProxyCommand='python3 ~/.local/pirc-ssh/sandbox-ssh-proxy.py %h %p'"
  }
}
```

- This replaces the `GIT_SSH_COMMAND` srt sets. `ssh` itself only gets these options through git; run it the same way if you need it directly.
- `-F /dev/null`: `~/.ssh/config` is unreadable, so every option is given here. Connection sharing stays off, as srt sets it, because its socket could not be created.
- `UserKnownHostsFile` must be writable; `accept-new` records GitHub's host key on first use. To pin it beforehand, write GitHub's published keys there.
- [`scripts/sandbox-ssh-proxy.py`](../../scripts/sandbox-ssh-proxy.py) does what srt's `nc -X 5` was meant to do, with the per-session credentials srt puts in `$ALL_PROXY`. The proxy still applies the domain allowlist: `github.com` without a port allows port 22, while hosts outside the list are refused. The script relies on those srt details, so check it again after a pirc upgrade changes srt.
- An `ssh-agent` instead of a key file: add its socket to `sandbox.network.allowUnixSockets`, put `SSH_AUTH_SOCK` in `env`, and drop `-i` and `IdentitiesOnly`. Agents can then use every key loaded in it. Not tested.
- Linux: srt's own `GIT_SSH_COMMAND` authenticates there (`socat … proxyauth`), but `~/.ssh` is still unreadable, so the same setup applies. Not tested.
- `gh` still needs the token setup; to use SSH for git and `gh` for the API, keep `GH_TOKEN`, `GH_CONFIG_DIR` and `SSL_CERT_FILE` from it and leave out `GIT_CONFIG_*`.

### What it does not cover

`web_fetch`, the `browser_*` tools and `web_search` run in the node's browser or on the gateway, outside the sandbox. A hostile node account or host is out of scope; the sandbox limits an agent, it does not make the machine safe from the person who configured it.

## Opt-in gateway agent runtime boundaries

The [opt-in gateway runtime](topology.md#opt-in-gateway-agent-runtime-evaluated-not-deployed) is not enabled by any shipped service. When composed, it has two boundaries that must not be confused:

- **Gateway phase worker** (`pirc-runtime-worker`): a per-run finite driver that receives only phase names and sequence numbers — no context, credentials, database, paths or network. Linux runs it under bubblewrap (private namespaces, UID 65534, no capabilities, scrubbed environment, tmpfs-only home/tmp) with seccomp filters that deny sockets, process creation, ptrace, mount and namespace changes, plus 512 MiB RSS supervision. macOS arm64 uses a native deny-default driver with adjacent bootstrap/inspection libraries and watchdog. Missing `bwrap`/`ldd`, failed kernel admission or an unsupported platform refuses startup. Gateway-only PTC scripts run in the native wasm3/QuickJS guest (`pirc-ptc-worker`) without ambient authority.
- **Node environment executor**: every tool, environment-only and mixed PTC script and hook runs in a session-scoped executor subprocess under the same srt policy described above. The node still owns `sandbox_allow_domains` and `unsandboxed_bash` approvals, final path checks and write leases; the gateway can only request them. An executor that cannot start leaves environment work refused, and uncertain cleanup quarantines the workspace durably across node restarts (`environment-journal.sqlite`). Do not delete quarantine records to "repair" a workspace.

The gateway worker sandbox protects the gateway host from the loop; it says nothing about whether workspace commands were sandboxed. Clients show the node executor's live sandbox status, never the worker's.

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
