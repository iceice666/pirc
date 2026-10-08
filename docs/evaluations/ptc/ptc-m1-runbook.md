# PTC Milestone 1 execution checklist

> The Opus run described below is stopped and retained for provenance. M1 subsequently completed under the approved [OpenAI revision](ptc-m1-openai.md#m1-baseline-accepted): `gpt-6.1-sol`, uncached/warm, independent USD 100 budget. Do not execute the old Opus CLI or reset its marker to start OpenAI evaluation.

Status: **Historical, superseded checklist; baseline-001 remains incomplete and stopped on cold-cache evidence.** The unchecked items below preserve that stopped run's state, not the current M1 backlog. Two valid measured trials, one warm-up and one cache-invalid trial are retained; do not restart or reset its marker. This checklist supersedes the earlier unreviewed draft, which misstated fixture count, inference transport and comparison scope. The authoritative protocol/evidence is [ptc-m1-evaluation.md](ptc-m1-evaluation.md).

## Scope and authorization

- M1 only; no M2 implementation or production tool-surface change.
- Baseline: `main@16c80846da64c07114d8cd43bab68748e5474127`, pinned node/chat binaries. `feat/ptc-only@3c783c5` has unchanged production code, **not a comparative PTC implementation**. M4 later compares the finished implementation.
- **15 total fixtures**, including cancellation and negative-permission cases; not 15 plus two.
- Authorized model `claude-opus-5-5`, Anthropic Messages, main-turn adaptive medium, output cap 16,384. Keep unchanged auxiliary feature behavior and record its settings.
- USD 100 official-price equivalent cap. Charge input/output/cache-write/cache-read at $4/$20/$8/$0.20 per million tokens; cache-write rate is deliberately conservative. Current conservative occupancy is **$8.9704356 / 44,852,178 units**, including a prior missing-usage request charged at its full $8.32768 reservation with maintainer approval. This is not the actual invoice; do not reset to the old $0.0213272 preflight-only amount.
- Provider credentials remain in trusted-sidecar memory. No credentials in source, process arguments, agent environment, catalog or reports. Memory-only stdin handoff was used for preflights on the replacement Arch host with no swap and core limit zero. The one authorized retry is consumed and protected by an exclusive attempted marker; do not remove it to rerun the preflight.
- Synthetic services/disposable state only. Never read historical sessions, perform real schedule changes, publish, purchase or send messages.

## Environment already prepared

The earlier isolated Debian/OrbStack machine and task-created Docker images were **deleted at the maintainer's request** after swap could not be disabled. Do not recreate them. The authorized replacement is a separate Arch Linux x86_64 host, reached through ordinary SSH over Tailscale with strict host-key verification. A dedicated test directory contains Bun 1.4.2 and the pinned baseline. System dependencies were installed by the maintainer; no swap is active. Live processes must set core size to zero before reading credentials. Keep hostnames, addresses, account names and credentials out of this tracked document.

Pinned Linux node/chat builds and hashes are recorded in the evaluation document. Full node confinement passed with the corrected **test-only** Unix inference transport. The new JSONL driver passed synthetic node/chat smoke under real srt and cgroup v2, but this does not prove descendant accounting or task success.

Docker probing stopped at nested `/proc` restrictions. Do not resume by adding privileged mode, unconfined seccomp, systempaths bypasses or weaker srt.

## Architecture being implemented

- Commands/events use the approved **JSONL agent RPC** measurement boundary, not gateway HTTP task dispatch.
- Model inference uses the existing authenticated **Unix socket**, not `gateway_request`. A trusted test sidecar connects that socket to the unchanged native adapter and an authenticated provider-wire observer.
- JSONL gateway/browser/UI requests are separately handled by deterministic synthetic services. Authorization claims require disposable daemon tests, not forged approval replies.
- Dedicated non-delegated systemd cgroups include srt, agent and descendants; provider/controller remain outside. Record `cpu.stat` and `memory.peak`, never label the latter RSS.
- Wall starts at prompt dispatch and ends at the matching post-dispatch `agent_settled`. Startup is separate. Resource sampling reports start lead/end lag; memory peak includes startup. Post-settled auxiliary billing remains in total usage.

## Offline validation

Run exact paths with `./` to avoid matching old source trees in build artifacts:

```sh
bun test ./apps/gateway/test/ptc-m1-fixtures.test.ts \
  ./apps/gateway/test/ptc-m1-metrics.test.ts \
  ./apps/gateway/test/ptc-m1-spike.test.ts \
  ./apps/gateway/test/ptc-m1-live-budget.test.ts \
  ./apps/gateway/test/ptc-m1-live-provider.test.ts \
  ./apps/gateway/test/ptc-m1-live-provider-errors.test.ts \
  ./apps/gateway/test/ptc-m1-live-resources.test.ts
bun run check
```

Provider tests use loopback fake models and Unix sockets. Where the surrounding sandbox denies socket creation, obtain approval for external execution; do not silently skip failures.

On the approved isolated Linux host, with placeholder paths replaced by verified binaries:

```sh
PTC_LINUX_NODE_BINARY=/absolute/baseline/pirc-node \
PTC_LINUX_CHAT_BINARY=/absolute/baseline/pirc-chat \
  bun test ./apps/gateway/test/ptc-m1-live-driver.test.ts
PIRC_TEST_SRT=embedded \
PIRC_TEST_AGENT_COMMAND=/absolute/baseline/pirc-node \
  bun test ./apps/gateway/test/sandbox-srt.integration.test.ts
```

## Remaining before the full baseline

All 15 fixtures passed synthetic real-srt runner integration; team uses the maintainer-approved trusted-binary cross-evidence, not OS-level writer provenance. Final remote preparation passed 85 tests / 468 assertions. The cohort CLI ran baseline-001 and stopped because its second cold initial request still read 13,577 cache tokens after the wait. Usage and cleanup were complete, but only two measured trials are valid. See [proxy investigation](ptc-m1-proxy-cache-findings.md). No further paid attempt is permitted merely by deleting a marker or replacing the old carry-forward value.

- [x] Implement and review cohort CLI/report, binary pins, resource windows and durable reservations (baseline-001 exercised this path; matrix acceptance is still incomplete).
- [ ] Complete driver/provider review fixes and negative lifecycle/cleanup tests; preserve evidence of unresolved liabilities across interrupted runs.
- [ ] Extend passed detached/short-lived cgroup and node/chat private-state probes to complete team-child attribution and remaining negative startup/cleanup coverage.
- [ ] Strengthen task/image/team/denial/cancellation oracles and disposable daemon authorization evidence. Any changed fixture prompt must be a shared, hashed protocol revision, never live-only rewriting.
- [ ] Establish deterministic service delays and the full all-attempt/auxiliary usage ledger.
- [x] Verify streaming live-provider behavior with the approved single-bash preflight (five complete attempts in preflight002); this is not full category validation.
- [ ] Resolve the deployed proxy's effective TTL/routing and obtain an approved reliable cold-cache method. Existing 310-second prewait plus actual usage correctly rejected the cache hit; charged same-path warm priming passed its first pair. Do not silently rewrite TTL or prompts.

## Baseline and M1 sign-off

- [ ] Run **10 valid cold + 10 valid warm trials for each of the 15 fixtures** on its appropriate pinned baseline binary; 300 measured trials total, plus warm-up/invalid attempts. Coding/chat reports stay separate; single-bash weight 5, others 1.
- [ ] Record all required metrics, protocol/fixture/binary hashes and environment. Missing metrics/categories or incomplete usage cannot pass readiness.
- [ ] Store aggregate metrics/fixed fixture IDs only; no raw requests, headers, scripts, arguments, results or transcripts in reports.
- [ ] Complete fresh review and repository-required validation before marking the two remaining M1 criteria done.

M4 regression bounds are already declared in the evaluation protocol; **M1 does not test savings against an unfinished PTC branch**. The all-or-nothing cutover decision belongs to M4, not this baseline run.
