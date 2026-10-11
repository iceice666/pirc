//! Workspace inspection for the panels (`node/inspect.ts`): git through the
//! `git` executable and files with realpath containment. Owner: **panels**.
//!
//! git: `git --no-pager -c core.quotepath=false -c core.fsmonitor=false -c
//! color.ui=false <args>`, no shell, `cwd` the real root, the environment
//! `without_secrets` plus `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`,
//! `GIT_PAGER=cat`, `LC_ALL=C`; 15 s then SIGKILL; stdout capped at 1 MiB
//! (`truncated`); exit codes other than 0 and 1 are 400 with the last three
//! stderr lines. Files: `resolve_inside` (404 for a missing path or an
//! absolute one outside, 403 for a relative or symlink escape, 400 for NUL),
//! directory listings without `.git`, dirs first in `localeCompare` order
//! (reuse the agent's `ls` ordering), 2000 entries; file reads with the
//! 1 MiB text and 8 MiB image limits.
