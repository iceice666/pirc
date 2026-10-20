# Open work

[Project](../README.md) · [Documentation](../docs/README.md) · [Historical records](../docs/development/historical-records.md) · [Rewrite](rewrite/README.md)

This is a work queue, not authorization. Each implementation needs the user's
go-ahead; nothing here authorizes deployment, paid evaluation, deleting state or
rerunning the `#[ignore]`d real-host-root tests.

The work queue is being rebuilt around the [rewrite](rewrite/README.md), which
lists its plans and their order. Where each item of the previous queue went
(kept, absorbed into a rewrite plan, changed or retired) is recorded in
[existing plans](rewrite/existing-plans.md). The previous queue, including its
manual validation and accepted limitations, can be read with
`git show c48337984080e4036454b66e3fecf9710894bedd:plans/README.md`.

Standalone plans:

- [Memory search](memory-search.md): workspace-memory search quality.
- [Mobile](mobile.md): Android app follow-up work and validation limits.
- [Modes](modes.md): data-driven workspace modes.
- [Sandbox GPU](sandbox-gpu.md): GPU access in the agent sandbox.
