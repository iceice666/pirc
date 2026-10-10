# Gateway runtime M6: audit cutover blockers

Status: **implemented and reviewed for the nine audit blockers; production
activation, deployment and cutover remain unauthorized.** Task-time gates are M7;
production composition and the cutover coordinator are M8.

Related: [plan](../../../plans/gateway-agent-runtime.md), [M5 audit](m5-evaluation.md#fresh-audit),
[M1 amendment](m1-contracts.md#amendment-m6-cutover-blocker-fixes).

## Resolution

| ID  | Finding (M5 audit)                                                | Resolution                                                                                                                                                                                                                                                                                             | Tests                                                                                                           |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| R1  | Undispatched intents block a session forever                      | Same-process undispatched intents (incl. after cancel, offline or worker failure) commit `rejected/not_started` when the run ends; the run's controller is aborted first so a detached loop cannot send them. Reconcile resolves the rest via node `unknown_execution`, for tools and lifecycle hooks. | `gateway-agent-runtime` (undispatched, failed worker, pending dispatch, lifecycle), `environment-m6-tombstones` |
| R2  | Node errors close the whole Environment link                      | Typed `environment.error` replies with fixed per-code messages; protocol violations alone close the link.                                                                                                                                                                                              | `environment-m6-errors`                                                                                         |
| R3  | Gateway-placed PTC stuck `running` after restart                  | `GatewayPtcService.recover()` (host startup) and authority startup sealing; PTC status/ack/cancel route by static placement and never ask the node about gateway-placed scripts.                                                                                                                       | `gateway-m6-recovery`, `gateway-host`                                                                           |
| R4  | Node fences not wired                                             | `LocalEnvironment` requires a fence (or an explicit test opt-out); newest fenced transfer only; supersession and revocation retire generations and cancel queued work without faulting other sessions.                                                                                                 | `environment-m6-fence-sweep`, `environment-m6-generations`                                                      |
| R5  | Non-atomic recover/retire; no crash sweep                         | `recoverAndRetire` in one transaction; node startup sweeps every unfinished generation before leases.                                                                                                                                                                                                  | `environment-m6-fence-sweep`                                                                                    |
| T1  | Invalid PTC store wedges the session                              | Commit the result without the store plus a `runtime.ptc.store_invalid` marker. The shared legacy `storeOf` is unchanged.                                                                                                                                                                               | `gateway-ptc-authority`                                                                                         |
| T2  | Invalid `ptc` call interrupts the run                             | Typed tool error (`InvalidArguments`/`CapabilityUnavailable`, "Nothing ran"), including scripts over the environment's time limit; nothing persisted.                                                                                                                                                  | `gateway-agent-runtime`                                                                                         |
| T5  | Central calls after the parent finished or the writer was revoked | Parents sealed on every outer commit and at gateway startup; fresh inner operations need the active writer generation; retries of known operations stay readable.                                                                                                                                      | `gateway-ptc-authority`                                                                                         |
| S2  | Fresh `/commands`, `/reconcile` skip the control lease            | Strict `clientId`/`generation`, lease checked before any writer lookup or effect, fail closed; the answer route now checks the lease first too.                                                                                                                                                        | `gateway-runtime-routes-lease`                                                                                  |
| R6  | Reconcile invents `unknown` on transient errors                   | Removed: only node-attested `unknown_execution` resolves; other errors are retryable.                                                                                                                                                                                                                  | `gateway-agent-runtime` (offline reconcile)                                                                     |

Gateway-local central intents that were persisted but never started are fenced with a
terminal not-started row, replacing the invented `unknown`.

## Known limits

- A gateway restart seals node-placed PTC parents that may still be running: their
  further central calls fail closed; outer results still reconcile.
- `unknown_execution` assumes the node journal is never restored on its own (see the
  backup guide). A gateway-placed PTC refused before local acceptance is resolved in the
  same process; one whose local record is missing after a crash stays unresolved
  rather than guessing, and the node is never asked about it.
- No production composition exists. A future one (M8) must pass the node fence, call
  `adoptRetiredGenerations` after the startup sweep, wire result/event push, and
  supply the control-lease verifier for the fresh routes.
- Not addressed (non-blocking audit items): R7 steering dropped at settlement, R8
  legacy approval answers during fencing, T3/T4/T6, S4–S6.

## Review

Three fresh reviewers (correctness/recovery, security, canonical) audited the first
implementation; their P1/P2 findings (a worker-failure race that could mark an executed
call not started, over-limit PTC timeouts, lifecycle recovery, gateway PTC status
fallback, superseded generations, revoke faulting other sessions, optional fence,
refresh ordering, error text leakage, tombstone cleanup) were fixed and tested. A
second-round reviewer confirmed those fixes with revert spot-checks and found one more
P2 (a fence retry reporting success after a failed retirement of the superseded
generation) plus P3 gaps (atomic lifecycle not-started receipt, gateway-placed refusal
before acceptance, placement-based reconcile routing, two untested fixes). All were
fixed with regression tests that fail when the fix is reverted.

## Validation

`bun run check` passed (with `CC` and the pinned `PIRC_WASM3_ARCHIVE`, in the
bubblewrap namespace that only supplies `/bin/bash` on this NixOS host): **1,203
gateway tests passed / 177 skipped / 0 failed**, **285 Web tests**, all builds and
**121 compiled-role tests**. Real-worker, native-PTC and real-srt opt-ins were not
enabled; the M5 matrix is re-run in M7.
