//! The native Linux backend (`spikes/linux-sandbox`). Owner: **sandbox**.
//!
//! bubblewrap with srt's argument order and the session policy's paths, a
//! network namespace whose only way out is a filtering HTTP/CONNECT proxy
//! on a Unix socket served by the node itself, and the in-sandbox bridge
//! (`pirc-node sandbox-bridge`, [`super::bridge`]) that exposes the proxy
//! as `127.0.0.1:3128` and then runs the agent. The proxy's allowlist is
//! shared with the session's [`super::NetworkControl`], so an approval
//! widens it in place (no control fd). The agent's stdio passes through
//! unchanged; `--die-with-parent`. srt's filesystem argument generation
//! (symlinks, missing paths, mandatory deny scan), SOCKS5 and the uid-0
//! cases are M7.
