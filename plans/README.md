# Active plans and follow-ups

[Project](../README.md) · [Documentation](../docs/README.md) · [Completed design history](../docs/history/README.md)

This directory is the work queue, not a description of everything already shipped. A document's acceptance, an old unchecked item, or its position in this index does not authorize implementation, deployment or paid evaluation. Follow the scope and decision gates in each plan; do not infer completion from an archive move.

## Proposed work and unresolved decisions

| Plan                                      | Recorded status and scope                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Assistant roadmap](assistant.md)         | v1 and in-chat USER approval/source-chat deletion shipped; remaining roadmap, decisions and watch items retain their own gates                                                           |
| [Project isolation](project-isolation.md) | Capability policy/instructions implemented; B, D, E1 and E3 are proposals, not privacy guarantees; E2 locally verified pending recorded review/release                                   |
| [Rust rewrite](rust-rewrite.md)           | All server roles in Rust under `crates/`, no embedded JS runtime, fresh-start release; M0 (conformance harness) and M1 (skeleton, budget, spikes) done 2026-10-10, M2–M9 open with gates |
| [Cross-feature backlog](backlog.md)       | Unresolved browser, schedules, Android, sandbox and accepted PTC follow-ups/manual checks extracted from completed designs                                                               |

## Audits with open findings

| Audit                                   | Recorded scope                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Mobile UI and parity](mobile-audit.md) | Remaining web/Android issues, deferred work and real-device checks from the dated audit         |
| [Security](security-audit.md)           | High/Medium fixed; Low/Info partly fixed, with open findings and historical resolution evidence |

These status descriptions summarize existing records, not a new code or device audit. In particular, old audit findings and limitations are not automatically current guarantees or proof of an unfixed regression.

## Completed work is elsewhere

- [Implementation history](../docs/history/README.md): assistant v1, browser, schedules, Android and sandbox designs.
- [Prompt/Context contracts](../docs/architecture/prompt-context.md) and [session UI](../docs/guides/session-ui.md): consolidated completed plans.
- [PTC evaluations](../docs/evaluations/ptc/README.md): accepted hybrid migration, protocols, stopped/superseded runs and unchanged aggregate artifacts. This is not an unfinished PTC-only roadmap.

When closing a plan, retain decisions and evidence in docs, move remaining work into an explicit backlog, and update this index. Do not silently erase open items or turn historical acceptance into a new execution authorization.
