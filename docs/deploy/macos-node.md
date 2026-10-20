# A node on macOS (launchd)

A Mac is a typical remote node: the repositories live in a user's home, and the node runs as that user under launchd. The gateway stays elsewhere. Everything on this page is the node's concern; the gateway needs only the node's ID and token in `PIRC_NODE_TOKENS` and a `/node/connect` route on the proxy.

Because the node runs as your own account, everything its agents can reach outside the sandbox is what you can reach. Keep the sandbox on ([Sandbox and browser](sandbox-and-browser.md)).

## 1. The executable

Choose one:

- **Nix (nix-darwin / Home Manager)**: use `pkgs.pirc-node` from the flake's overlay. The native binary includes its sandbox and CDP drivers; Chromium and ffmpeg come from `PIRC_BROWSER_EXECUTABLE`/`PIRC_FFMPEG` or `PATH`.
- **Native binary without Nix**: build on a Mac with Rust and Apple's command-line tools:

  ```sh
  cargo build --locked --release -p pirc-node
  otool -L target/release/pirc-node # must not reference /nix/store for portable builds
  target/release/pirc-node --version
  ```

  Copy it to `~/.local/pirc-node/bin/pirc-node`. No Bun, Node, srt or Playwright installation is needed. Install git and Chromium/Chrome (optional ffmpeg for recording); macOS provides `sandbox-exec`. Existing 0.3.0 installations must use [fresh state](upgrades.md).

## 2. Layout

```
~/.local/pirc-node/
├── bin/pirc-node     (compiled build only)
├── agent.env         PIRC_* for the node, mode 0600
├── state/            PIRC_STATE_DIR
├── agent.log         stdout
└── agent.err         stderr
~/.config/.pirc/      PIRC_CONFIG_DIR: config.json, AGENTS.md, skills/
```

`agent.env`:

```sh
PIRC_NODE_ID=m5pro
PIRC_NODE_TOKEN=…                      # matches the gateway's PIRC_NODE_TOKENS["m5pro"]
PIRC_DAEMON_URL=wss://pirc.example.ts.net
PIRC_ALLOWED_USERS=alice@example.com
PIRC_STATE_DIR=/Users/alice/.local/pirc-node/state
PIRC_WORKSPACES=[]                     # add workspaces from the web; they must be under the home
```

`agent.env` sits outside `PIRC_STATE_DIR`; the sandbox hides `~/.local/pirc-node` from agents by default. If you keep the env file elsewhere, add its directory to `sandbox.filesystem.denyRead` in `~/.config/.pirc/config.json`:

```json
{ "sandbox": { "filesystem": { "denyRead": ["~/path/to/env-dir"] } } }
```

## 3. The launchd job

`~/Library/LaunchAgents/dev.pirc.node-agent.plist` (launchd has no env-file support; a shell wrapper sources it):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.pirc.node-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>set -a; . "$HOME/.local/pirc-node/agent.env"; set +a; exec "$HOME/.local/pirc-node/bin/pirc-node"</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>/Users/alice/.local/pirc-node/agent.log</string>
  <key>StandardErrorPath</key><string>/Users/alice/.local/pirc-node/agent.err</string>
</dict>
</plist>
```

- `PATH` must include where `git`, `chromium`/Chrome and `ffmpeg` live (Homebrew: `/opt/homebrew/bin`). With Nix, use the profile's `bin`.
- With Home Manager, `launchd.agents.<name>` generates this; put `agent.env` outside the store since it holds the token.

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.pirc.node-agent.plist
launchctl kickstart -k gui/$(id -u)/dev.pirc.node-agent     # restart after replacing the binary
launchctl bootout gui/$(id -u)/dev.pirc.node-agent          # stop
pgrep -fl "pirc-node"
tail -f ~/.local/pirc-node/agent.log ~/.local/pirc-node/agent.err
```

## 4. Replacing the binary (compiled build)

```sh
scp target/release/pirc-node mac:.local/pirc-node/bin/pirc-node.new
ssh mac 'chmod 755 ~/.local/pirc-node/bin/pirc-node.new \
  && mv ~/.local/pirc-node/bin/pirc-node.new ~/.local/pirc-node/bin/pirc-node \
  && launchctl kickstart -k gui/$(id -u)/dev.pirc.node-agent \
  && sleep 4 && pgrep -fl "pirc-node"'
```

Replace with `mv` (atomic) rather than overwriting in place: a running process keeps the old inode.

## macOS specifics

- **App Management prompt**: macOS may block a Home Manager activation from rewriting the plist ("App Management" privacy setting). Allow your terminal under _System Settings → Privacy & Security → App Management_, or bootout, copy the plist by hand and bootstrap again.
- **Sleep**: a sleeping laptop is an offline node. Its sessions answer `503` until it is back; nothing is retried on its own.
- **Sandbox**: the native node uses Seatbelt (`sandbox-exec`). macOS caps Unix socket paths at 104 bytes; the node keeps its own sockets short, but keep `PIRC_STATE_DIR` at a reasonable depth. `allowUnixSockets` lists extra sockets (an `ssh-agent`, the Nix daemon) the agent may reach.
- **Git over SSH** does not work inside the sandbox (`~/.ssh` is unreadable, and `ssh` does not use the sandbox's proxies); the agent asks through `unsandboxed_bash`, which you approve per command. HTTPS remotes with a narrowly scoped token in the workspace's `.pirc/config.json` `env` work without leaving the sandbox.
