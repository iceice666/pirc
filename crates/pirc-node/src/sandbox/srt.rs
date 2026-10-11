//! The external srt-compatible wrapper (`PIRC_SANDBOX_SRT`), the
//! development stand-in: `node/sandbox.ts` with an external srt, and
//! `srtSettings`. Owner: **sandbox**.
//!
//! Probe: `<srt> --settings <state>/sandbox/probe.json -- /bin/sh -c 'exit
//! 0'`. Prepare: `<srt> --settings <state>/sandbox/<basename(session)>.json
//! --control-fd 3 -- <agent command> <agent args...>`; the settings
//! (`srtSettings`: network allow/deny lists, local binding,
//! `allowAllUnixSockets` on Linux, filesystem rules, `allowGitConfig`,
//! `allowPty`; no seccomp entry) written 0600; a [`super::NetworkControl`]
//! that maps a pipe to the agent's fd 3 (the `command-fds` crate) and
//! writes `JSON(settings(approved)) + "\n"` on approval; `CLAUDE_CODE_TMPDIR`
//! a fresh `pirc-XXXX` under the system temp directory.
