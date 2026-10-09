# Gateway runtime M2/M3: Linux implementation and macOS handoff

Status: **M2/M3 implementation continued under the maintainer's request to finish
what can be done without macOS validation. The opt-in fresh-session runtime works
on Linux; macOS acceptance remains open. Production routing/cutover is not enabled.**
This record supersedes the outstanding implementation lists in
[M2 completion](m2-completion.md), [M3 authority foundation](m3-authority-foundation.md)
and [turn lifecycle](m3-turn-lifecycle.md), retaining their historical platform
evidence. [The plan](../../../plans/gateway-agent-runtime.md) keeps M4 product
parity and M5 evaluation/cutover separate.

## Runtime and authority

`gateway-runtime/runtime.ts` joins the existing provider service, Environment
transport and turn lifecycle. `worker.ts` is a shipped finite model/tool loop
driver. The trusted supervisor owns context, model authorization, provider calls,
policy, node binding and SQLite authority. The worker receives only sequence
numbers and allowed next-phase names, without context, credentials, provider API,
database, paths or arbitrary capability arguments. This narrow worker is not the
old node Agent with its complete feature registry.

- Fake-provider coding/chat flows persist user/assistant/tool messages and provider
  replay metadata. Provider tool-call IDs remain distinct from transport UUIDs.
  Complete inference context stays on the gateway. Direct provider-to-UI events
  use existing pi `message_start`, `message_update`, `message_end` shapes; the end
  event follows durable commit. A lost live sink recovers history/outbox references.
- Model completion and dispatch intents commit together before `execution.start`.
  Tool results and transcript receipts commit before ACK. Lost ACKs retry the
  original digest. Interrupted calls, unsent intents and unknown effects never
  trigger automatic model/tool replay. New runs are blocked by unresolved intents.
- Restart marks running runs/pending model calls interrupted. Status-only recovery
  reconciles original IDs. Finished run-ID retries return durable state even
  offline. History stays readable offline; new environment-dependent model/tool
  work is refused. Unknown results stop continuation.
- Steering is durable, deduplicated and consumed at admitted turn boundaries.
  Model/thinking settings inherit branch ancestry and survive restart; fallback
  persists its selected model. Unavailable selections fail explicitly. Main,
  fallback, title, memory and compaction calls all use the existing gateway
  inference service and required trusted model authorization.
- Compaction uses existing safe user-turn boundaries, retaining summary-call
  metadata outside ordinary model history. Titles project as `session_info`.
  Memory here is a gateway summary-call path; complete observer/workspace-memory
  features remain M4.
- Immutable turn descriptors and pinned user images are enforced. Descriptor or
  generation changes fail closed without implicit replacement, reused approvals
  or quarantine release. Tool artifacts are pinned before result commit/ACK.

Fresh-session provisioning/fencing is a trusted lifecycle API. UI/model RPCs cannot
provision sessions, manufacture leases or stop old writers. The authenticated node
WebSocket fixture provisions an independently fenced fresh binding and exercises
the runtime across the existing connection; it imports no legacy files.

## Linux worker isolation

`worker-process.ts` launches only the operator-selected compiled worker, resolving
its loader/library files before spawning and mounting those exact assets read only.
Unavailable bubblewrap, namespaces, dependencies or unsupported platforms refuse
startup; there is no ordinary subprocess fallback.

Private user/mount/PID/network/IPC namespaces use UID/GID 65534, no capabilities,
`no_new_privs`, private proc/dev, an empty HOME and scrubbed environment. HOME and
`/dev/shm` each have 1 MiB tmpfs; `/tmp` has 16 MiB. No host home/workspace/state
directory is mounted. Only bounded stdin/stdout/stderr IPC is inherited; filter
and trusted status FDs are closed before worker exec.

The outer seccomp filter denies sockets, process creation, ptrace, mount, namespace
changes, io_uring and related escape surfaces. Thread-only clone supports Bun;
clone3 returns ENOSYS for libc's restricted fallback. Shipped startup installs a
second filter with thread synchronization **before reading IPC**, denying further
execve/execveat and memfd creation. This closes the initial exec exception so
generated native code cannot replace the worker.

RSS monitoring uses the host PID from bubblewrap's private trusted status pipe,
never a child-supplied PID. RSS overflow, invalid/mismatched IPC, unexpected exit
or diagnostic overflow interrupts the run. Real Linux tests attempt host reads,
environment/FD leaks, raw socket, mount/ptrace/unshare/exec/memfd syscalls,
subprocess creation, asset writes and forged provider/binding IPC. Fake node
executors are not counted as containment evidence.

## Quotas, readers and node recovery

- Eight global active runs, one/session, excess rejected as busy; no run queue.
  Cancellation/shutdown releases slots even if a provider ignores its signal.
  Worker RSS is 512 MiB, within eight workers' 4 GiB aggregate budget, supervised
  every 100 ms. Runs have a one-hour deadline and 128 main iterations; model calls
  have ten-minute deadlines.
- Context/request serialization is limited to 8 MiB before image-bearing entries
  are materialized. Steering queues have 16 turns. Worker frames/diagnostics are
  4 KiB with one pending request. Provider delta/partial/total quotas abort overflow.
- History pages contain at most 32 entries/8 MiB; outbox pages contain 128 references.
  Recovery pages contain at most 32 pending/unknown intents with retained-byte
  checks before parsing, a cursor and small status references instead of terminal
  bodies. Reconciliation never dispatches work.
- Owner/workspace recaps select up to 16 fresh sessions, 32 recent messages/session,
  80,000 text characters total, with redaction and explicit sampling/truncation.
  Recaps do not load images or legacy JSONL.
- Artifact readers accept only opaque IDs referenced by the owned session,
  verify node/hash ownership and use a 60-second fetch deadline. Offline references
  are unavailable. Untrusted MIME cannot produce active HTTP origin content.

`routes.ts` is an explicit registrar for an isolated fresh-runtime app. The host
supplies existing forward/device authentication and trusted writer lookup. It
offers history/settings/context/events/recap/artifact readers and prompt, steer,
stop, model/thinking and reconcile commands, with strict schemas. The production
daemon does **not** register these routes. Production control leases, asynchronous
command UX and Web/Android parity remain M4/M5 work.

Node startup opens its durable Environment journal/writer-fence database and
restores quarantine before constructing runners. Runner launch and delivery check
legacy deny fences, including schedule/delegation dispatch. A restart test proves
that a different session cannot acquire a quarantined workspace while unrelated
workspaces remain available. No live writer is stopped. The accepted conservative
macOS/no-cgroup quarantine policy remains; automatic aggregate regrant requires
independently verified fencing.

Shared hook execution now preserves exit status/stdout when a hook intentionally
closes stdin early (EPIPE). Existing direct/PTC fixtures validate denial, rewritten
arguments, annotations and context without losing that result. Complete runtime
lifecycle feature hooks remain M4.

Gateway builds include `pirc-runtime-worker`; Nix installs it in `libexec/pirc`.
The opt-in Linux launcher needs bubblewrap and ldd in its trusted environment.
Nix evaluation/build was not run because this environment has no Nix installation.

## Verification (2026-10-08)

Linux x86_64, Bun 1.4.2, Node 24.19.0. No real provider calls, credentials, private
histories, deployment, legacy import or deletion were used. Real worker tests ran
directly on this Linux environment without an outer test sandbox:

```sh
mkdir -p work
bun build --compile --minify apps/gateway/src/entry/runtime-worker.ts \
  --outfile work/pirc-runtime-worker
bun build --compile --minify apps/gateway/test/fixtures/gateway-worker-probe.ts \
  --outfile work/gateway-worker-probe
bun build --compile --minify apps/gateway/test/fixtures/gateway-worker-forged.ts \
  --outfile work/gateway-worker-forged
PIRC_TEST_GATEWAY_WORKER="$PWD/work/pirc-runtime-worker" \
PIRC_TEST_GATEWAY_PROBE="$PWD/work/gateway-worker-probe" \
PIRC_TEST_GATEWAY_FORGED="$PWD/work/gateway-worker-forged" \
  bun test apps/gateway/test/gateway-worker-isolation.test.ts \
    apps/gateway/test/gateway-agent-runtime.test.ts \
    apps/gateway/test/gateway-node-fences.integration.test.ts \
    apps/gateway/test/environment-transport.integration.test.ts
```

Result: **21 passed / 0 failed, 166 assertions**, including real-worker coding and
authenticated node transport. Authority/lifecycle/runtime focused suites also
passed **30 tests / 1 real-worker test skipped without opt-in / 0 failed, 217 assertions**.
The real node srt suite passed **7 / 1 delegated-cgroup test skipped / 0 failed,
35 assertions**. No cgroup was delegated here; historical results are separate.

This container's PID 1 does not reap orphan zombies. Existing kill(pid,0) and
runner-death assertions therefore failed despite terminated processes. Repository
and node srt checks use an outer PID namespace with bubblewrap's normal reaper and
full host bind for test-process compatibility, **not isolation evidence**. Inner
worker/srt profiles supply containment. jsdom uses Node 24's compatibility option:

```sh
NODE_OPTIONS=--no-experimental-webstorage \
  bwrap --unshare-user --unshare-pid --dev-bind / / --proc /proc \
    --die-with-parent -- /bin/bash -c 'bun run check'
PIRC_TEST_SRT=embedded \
  bwrap --unshare-user --unshare-pid --dev-bind / / --proc /proc \
    --die-with-parent -- /bin/bash -c \
    'bun test apps/gateway/test/environment-subprocess.test.ts apps/gateway/test/sandbox-srt.integration.test.ts'
```

Full `bun run check` passed: version/format/typechecks, **1077 gateway tests passed /
117 skipped / 0 failed**, **284 web tests passed**, all web/role/worker builds and
**121 compiled-role tests passed**. Skips are not counted as verified. The new
worker isolation suite also passed from a UID 1000/capability-free test namespace
(**4 tests / 26 assertions**); this is an additional launcher check, not separate
host-account isolation evidence. No existing timeout/security gate was relaxed.

## Open platform and activation gates

- **macOS worker**: currently explicitly unsupported. Equivalent enforced
  filesystem/network/process isolation, resource supervision and real adversarial
  tests must be implemented/validated on macOS before support is claimed.
- **macOS regression**: run `bun run check` and the new authority, lifecycle,
  runtime, node-fence and Environment transport suites in a disposable checkout.
  Revalidate quarantine across a real node restart and approvals/artifacts against
  real srt. Linux probe flags are not a substitute for a macOS isolation fixture.
- **M4/M5**: complete hybrid PTC routing, central capabilities, lifecycle feature
  hooks, teams, memory features and Web/Android presentation remain M4. Performance
  comparisons, backups, operational writer transfer/version negotiation, production
  routing and explicit cutover remain M5. This runtime currently advertises only
  trusted installed node-placement capabilities and does not claim full Agent parity.

No production gateway route has been replaced and no existing session was adopted.
