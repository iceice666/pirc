# Architecture references

[All documentation](../README.md) · [Current topology](../deploy/topology.md)

| Reference                                            | Covers                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Model backends and authentication](backend-auth.md) | Gateway-owned inference and provider credentials, subscription logins and trust boundaries |
| [Observational memory](observational-memory.md)      | Session/workspace memory, extraction, storage, recall and validation                       |
| [Prompt and Context contracts](prompt-context.md)    | The brain's and the workers' prompts, node-local snapshots and authorized relays           |

- [Memory, open loops, wakes and workers](memory.md): the brain's three layers of memory, origins and forgetting, open loops, waking up, repository identity and the brain's workers.
- [Direction](direction.md): the direction the rewrite implemented (2026-10-19, in Chinese), kept as written.
- [PTC runtime contracts](ptc.md): discovery, per-operation authority, attachments and execution lifecycle.
- [Security decisions and accepted limits](security-decisions.md): current trust boundaries and accepted risks.

See also [native management authorization](native-management.md) for temporary App management grants and browser consent.

Completed designs, Rust cutover provenance and PTC evaluation evidence are available through [Historical records in Git](../development/historical-records.md).
