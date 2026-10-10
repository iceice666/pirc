# Spike C: the Linux agent sandbox without srt

M1 spike for [the Rust rewrite](../../plans/rust-rewrite.md): can a Rust `pirc-node` confine agents on Linux the way `@anthropic-ai/sandbox-runtime` (srt) does for it today, without Node?

`src/main.rs` (about 400 lines, no dependencies) turns a session policy shaped like `sandbox-policy.ts` output into bubblewrap arguments in srt's order, runs the command in its own network, PID and user namespaces, and gives it one way out: an HTTP proxy on a Unix socket in the host namespace that allows listed domains. Inside, the same executable (`inner`) bridges `127.0.0.1:3128` to that socket, which is what srt runs socat for. The allowlist can grow while sessions run, as a human approval does through srt's `--control-fd` today.

pirc runs srt with `allowAllUnixSockets` on Linux (`node/sandbox.ts`), so srt's seccomp helper is not in use and is not part of the spike.

Run: `PATH=<bubblewrap>/bin:$PATH cargo run --release -- selftest`. The checks are the spike's own; `apps/gateway/test/sandbox*.integration.test.ts` are node-level tests (agent start, approvals) that belong to M6 and M7.

## Result (2026-10-10, NixOS, bubblewrap 0.12.0, Rust 1.98.1)

All 20 checks pass; a sandboxed command starts in about 15 ms. The release executable is 505 KiB.

| Check                                                               | Expected | Mechanism                       |
| ------------------------------------------------------------------- | -------- | ------------------------------- |
| `exit 0` (the node's probe)                                         | runs     |                                 |
| read / write the workspace                                          | allowed  | `--bind` write root             |
| write outside the write roots, or the home directory                | refused  | `--ro-bind / /`                 |
| read `~/.ssh`, the node's private state                             | refused  | `--tmpfs` over the directory    |
| read and write the session dir inside the private state             | allowed  | bound back inside the tmpfs     |
| write `.git/hooks`, `.git/config`, `.pirc`, `~/.bashrc`             | refused  | `--ro-bind` inside a write root |
| write `/tmp`                                                        | allowed  | write root                      |
| signal a host process                                               | refused  | `--unshare-pid`, fresh `/proc`  |
| unmount a denial (as a normal user: not a test of `--cap-drop ALL`) | refused  | no capabilities                 |
| connect directly to a host port                                     | refused  | `--unshare-net`                 |
| GET or CONNECT through the proxy to an allowed domain               | allowed  | Unix-socket bridge, proxy       |
| GET through the proxy to another domain                             | 403      | proxy allowlist                 |
| the same domain once approved at runtime                            | allowed  | shared allowlist                |

## Conclusions

- Feasible: bubblewrap does the confinement; the parts srt implements in JavaScript (argument generation, the filtering proxy, the bridge) are small in Rust and need no external socat.
- **Port srt's algorithm, do not redesign it.** `generateFilesystemArgs` in srt's `linux-sandbox-utils.js` handles cases this spike ignores, each a sandbox escape or a startup failure if missed:
  - symlinks: mounts land on canonical paths, never on a symlink (bubblewrap 0.12 refuses that), and symlinked spellings of denied paths are covered;
  - deny paths that do not exist yet get `/dev/null` stubs, except inside read-only mounts where bubblewrap cannot create them;
  - a deny of `/` is expanded into its children; `/proc`, `/dev`, `/sys` are handled apart;
  - the mandatory deny scan (ripgrep over write roots, `DANGEROUS_FILES`, depth-limited) finds hooks and rc files anywhere under a write root, not only at fixed paths;
  - transient `stat` failures widen a denial rather than drop it;
  - capabilities: `--cap-drop ALL` matters most when the node runs as uid 0 (containers, root services), where bubblewrap would otherwise keep capabilities and, without srt's seccomp helper, a command could unmount a denial; srt also handles a missing `CAP_SETFCAP` there. The selftest runs as a normal user only.
    srt is Apache-2.0; a port keeps its notice.
- The proxy needs what this one lacks before M7: SOCKS5 (srt's `ssh` path, `scripts/sandbox-ssh-proxy.py`), `deniedDomains`, `allowLocalBinding`, HTTP keep-alive and request bodies, and limits on header size and connections.
- macOS (Seatbelt profiles from `macos-sandbox-utils.js`) is not covered here and needs its own check on a Mac.
- `bwrap` stays an external runtime dependency, as it is for srt today.
