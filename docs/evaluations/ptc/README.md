# PTC evaluation and migration archive

[All documentation](../../README.md) · [Current tool guide](../../guides/tools.md) · [Accepted follow-ups](../../../plans/backlog.md#accepted-ptc-follow-ups-and-release-checks)

## Outcome and reading order

**The hybrid surface was accepted and merged on 2026-10-07.** Core tools are available directly and through `ptc`; other capabilities are reached through `ptc`. The original PTC-only target was superseded, not shown to pass. Failed rounds remain failed, round 3 remains incomplete, and the later public holdout passed its separately declared bounds. Recorded chat limitations were accepted by the maintainer.

1. [Migration, acceptance and review](ptc-only.md): original design, completed milestones, cutover decision and remaining manual release checks.
2. [Accepted OpenAI M1 baseline](ptc-m1-openai.md#m1-baseline-accepted): baseline acceptance and preceding amendments/continuations.
3. [M4 comparison protocol and results](ptc-m4-evaluation.md): pre-declarations, five rounds and the public benchmark.
4. [Inventory](ptc-m1-inventory.md) and [contracts](ptc-m1-contracts.md): historical M1 capability and reference-contract snapshots, not a second production permission system.

## Superseded preparation and stopped runs

- [Original M1 protocol and evidence](ptc-m1-evaluation.md)
- [Stopped Opus execution checklist](ptc-m1-runbook.md)
- [Proxy cache investigation](ptc-m1-proxy-cache-findings.md)

Their unchecked items and spend approvals belong to those historical runs. They are not a current backlog or permission to run a CLI, restart a process, reset attempt markers or spend again. The OpenAI baseline replaced the Opus comparison requirement; the old budgets and artifacts remain separate.

## Aggregate evidence

| Artifact                                              | Role                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| [Preflight 001](ptc-m1-preflight-001.json)            | Failed-closed preflight evidence, not baseline acceptance   |
| [Preflight 002](ptc-m1-preflight-002.json)            | Completed preflight, not the full baseline                  |
| [M1 OpenAI baseline](ptc-m1-openai-baseline.json)     | Accepted baseline: 300 measured trials and 150 primes       |
| [M4 round 1](ptc-m4-openai-evaluation.json)           | PTC-only comparison; bounds failed                          |
| [M4 round 2](ptc-m4-round2-evaluation.json)           | PTC-only with signatures; bounds failed                     |
| [M4 round 3](ptc-m4-round3-partial.json)              | Incomplete interleaved hybrid comparison; no verdict        |
| [M4 round 4](ptc-m4-round4-evaluation.json)           | Hybrid comparison; bounds failed                            |
| [M4 round 5](ptc-m4-round5-evaluation.json)           | Final optimization comparison; original bounds still failed |
| [Public development set 1](ptc-m4-polyglot-dev1.json) | Public-benchmark development/tuning evidence                |
| [Public development set 2](ptc-m4-polyglot-dev2.json) | Second development/tuning run                               |
| [Public holdout](ptc-m4-polyglot-holdout.json)        | 19-exercise holdout; declared bounds passed                 |

The 11 JSON files were moved from `plans/` without changing their bytes. Scripts in `scripts/ptc-*` and the offline bounds tests now read them here. Recorded source/binary/controller hashes still identify the original evaluated versions; relocating documentation and updating readers does not re-pin historical runs or authorize reruns. Do not reformat artifacts, regrade failed rows or discard incomplete evidence.
