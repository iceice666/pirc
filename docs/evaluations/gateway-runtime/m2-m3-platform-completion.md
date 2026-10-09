# Gateway runtime M2/M3: platform completion

Status: **remaining M2/M3 implementation and focused Linux/macOS acceptance passed
for the opt-in fresh-session runtime.** Production routes, live writer transfer,
legacy import and cutover are not enabled. M4 product parity and M5 evaluation and
activation remain separate. This continuation supersedes the open implementation
lists in [the Linux record](m3-linux-runtime.md) and the initial
[macOS regression record](m3-macos-validation.md), retaining their historical
results, unsuccessful attempts and limits.

## Scope and environment

Work continued from `9b9c4ee2e7d8d595ca2d09b2ebd6a98ca1c3b2b3` under the
maintainer's request to finish remaining M2/M3. Validation used fake providers,
fixture sessions and disposable workspaces, not provider credentials or private
histories. No existing writer was stopped or adopted, no production route was
registered, and no old data was imported or deleted.

macOS verification ran over `ssh m3air`: **macOS 26.5 (25F71), Darwin 25.5.0,
arm64, Bun 1.4.2, Node 26.7.0**, embedded sandbox-runtime **0.0.78**. The shell
was outside Seatbelt (`sandbox_check(self, NULL, 0) = 0`); tests used a clean
environment and an isolated HOME outside `/tmp`. Linux verification used Bun
**1.4.2**, Node **24.21.0**, x86_64. Linux shell/reaper compatibility uses the
previously documented outer PID/mount namespace; that outer namespace is **not
worker or node isolation evidence**.

## M2: real node-sandbox recovery and returned artifacts

`environment-real-srt-recovery.integration.test.ts` is explicitly opt-in and uses
a shipped executor under real embedded srt, the authenticated node WebSocket,
actual `startNode`/`buildNodeApp`, and their durable startup journal/write broker.
The trusted harness initializes only after startup restores quarantine and before
registration. The optional interaction factory wires existing authenticated
owner/control ingress; it is not a new production session-provisioning endpoint.

The combined fixture and focused regressions verify:

- Sandbox-produced/read image bytes enter trusted node artifact storage without
  interpreting child-provided host paths or accepting manufactured artifact IDs.
- Node-owned host-execution approvals reject wrong owners, stale control and
  replay; an approved fixture operation runs once. Disconnect invalidates the
  pending approval, and its effect does not execute.
- Artifact transfer checks ownership/hash; pin precedes authoritative result
  commit and ACK. A lost ACK reply recovers by original ID.
- An uncommitted artifact/result survives both-end restart. Production
  `GatewayAgentRuntime.reconcile` performs status-only recovery, without launching
  a worker, model call or replacement execution. Pin failure cannot commit or ACK;
  retry reconciles the original result once.
- Real executor termination leaves unknown effects, durably quarantines the
  original binding and restores write fences on actual node startup. The original
  and different sessions cannot reacquire the workspace, including after release;
  an unrelated workspace can continue.

The executor now ingests bounded returned image bytes before resolving its
terminal result. It enforces canonical base64, image MIME, 5 MiB/image, 32 images
and 16 MiB total; partial storage failure, cancellation and suppressed publication
roll back newly created unpinned references. Cancelled text terminals retain the
existing reusable-executor/background-wait semantics. A fresh reviewer found the
initial cleanup/cancellation defects; fixes and regression tests are included.

Restart coverage closes and reopens actual gateway/node runtimes and SQLite files
**inside the integration process**; executor interruption is a real subprocess
termination. It does not claim abrupt whole-node-supervisor crash or power-loss
safety. Abrupt supervisor death between artifact reservation/storage and journal
linkage can leave inaccessible physical reservations/files. The existing store
has no startup orphan reconciliation; these consume its 256 MiB/session quota.
No automatic deletion or quarantine regrant was added to conceal that limitation.

## M3: macOS native worker and enforced launch

The worker is still the existing **finite `model` / `tools` / `done` phase driver**,
not the old node Agent registry. Context, provider calls, model authorization,
SQLite authority, capabilities and policy remain in the trusted gateway
supervisor. Linux uses the shipped Bun driver; Darwin builds a small native driver
with the same phase/sequence interface. Its closed canonical JSON grammar rejects
unknown/duplicate fields, noncanonical numbers, NULs, truncation and oversized
frames. Native protocol tests are separate from containment tests.

`pirc-worker-watchdog` is a trusted native launcher, not guest code. It arms kernel
process-exit observation of the gateway before spawning, owns the guest PID until
`waitpid`, and kills/reaps the guest if the gateway exits or requests termination.
PID ownership prevents cleanup from targeting a reused unrelated PID. Checked
`POSIX_SPAWN_CLOEXEC_DEFAULT` and explicit FD actions retain only bounded guest
stdin/stdout/stderr plus native profile/readiness/admission FDs. A separate native
status FD reports the guest PID and is closed before guest exec. SIGPIPE, partial
writes, early SIGTERM and startup close races fail closed.

The injected trusted bootstrap runs before native application entry, not before
every prerequisite Apple library initializer. It:

1. Clears inherited registered/exception/bootstrap authority, removes foreign
   send rights, drains bounded pre-entry receive queues and destroys received
   descriptors, then verifies no foreign send rights remain. Local task/thread
   handles and receive/reply endpoints are not host-service send authority. The
   shipped bootstrap issues no asynchronous service requests at this stage.
2. Closes non-IPC descriptors, strips injection variables, disables core dumps,
   and applies a deny-default Seatbelt profile with syscall inference disabled.
3. Enforces positive finite Unix/Mach/MIG sets. There is no process exec/fork,
   socket, host-file write, IOKit/NVRAM or peer-process permission. Only exact
   read-only installed assets and required Apple libraries are readable; no
   writable filesystem or temporary directory is available to the guest.
4. Proves numeric syscall 202 cannot read the existing same-UID parent's process
   arguments and proves protected HOST/ACCESS special-port getters return
   `KERN_DENIED` without a port. Darwin cannot overwrite populated protected slots
   as an unprivileged process; all materialized rights are removed and kernel MIG
   retrieval is denied instead. No general cleanup error is ignored.
5. Signals native readiness, closes its status FD and waits for supervisor
   permission. The supervisor independently checks kernel denials and trustworthy
   PID/RSS before releasing application entry; forged readiness is insufficient.

RSS inspection uses native `proc_pidinfo` with its exact structure size, not a
worker-reported PID. The 512 MiB limit counts guest plus watchdog; global eight-run
admission remains unchanged. RSS failures get only a bounded post-admission exit
race grace, never an indefinite monitoring exemption. Existing frame/output,
iteration and deadline limits remain. Gateway death cleanup is verified against a
hostile native worker that ignores stdin EOF.

Missing assets, ineffective filters, ignored injection, unsupported architecture,
failed native guards or inspection refuse startup; there is no ordinary subprocess
fallback. Real acceptance was run on macOS arm64. Darwin x86_64 and other OS
versions are not separately verified; runtime guards remain mandatory there.

### Security discoveries retained in the record

The implementation did not treat successful profile compilation as containment:

- Higher-level `sysctl-read`/process-info denial did **not** block numeric
  `KERN_PROCARGS2`; actual syscall filtering with `(disable-syscall-inference)` was
  required. Raw and libc queries are now denied.
- Higher-level special-port denial alone did **not** prevent protected-port
  retrieval. The kernel MIG routine `task_get_special_port_from_user` is denied,
  and native plus hand-built MIG tests prove enforcement.
- Kernel routine names are not always sandbox compiler aliases: the target accepts
  `mach_ports_lookup`, not `_kernelrpc_mach_ports_lookup3`. Actual compiler and
  behavioral evidence, rather than guessed names, determined the final policy.
- Bun initialization did not work under the required early restrictions. Darwin
  uses a native equivalent of the existing finite driver rather than restoring
  unsafe permissions. The experimental metadata shim is not shipped.
- Probe defects (invalid null bootstrap lookup, wrong modern Mach-message class,
  missing header, hardcoded observations and memory-write optimization risk) were
  corrected rather than counted as denial evidence. A missing bootstrap port is
  reported as unavailable authority, not a lookup attempt that never occurred.

Sources informing the investigation, independently checked against actual tests:
[XNU process/sysctl implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c),
[XNU Mach inheritance and special ports](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/ipc_tt.c),
[XNU Mach message ABI](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/message.h),
and [WebKit's macOS sandbox profile](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/WebProcess/com.apple.WebProcess.sb.in).
Private sandbox interfaces may change; source inspection is not a substitute for
platform probes and fail-closed startup.

## Validation evidence

Final focused commands ran outside an outer macOS sandbox with the clean
environment above. Compile all native fixture executables beside the installed
bootstrap/inspection/watchdog assets; they are fixture code, not alternate
production workers.

```sh
bun scripts/build-gateway-worker.ts
# Build the macOS C probe/forged/memory/fork/ports/stall fixtures with clang -O2.
# Build the ports helper with -DPIRC_PORTS_HELPER -dynamiclib and the forged
# bootstrap fixture with -dynamiclib.

PIRC_TEST_GATEWAY_WORKER="$PWD/apps/gateway/dist/pirc-runtime-worker" \
PIRC_TEST_GATEWAY_MACOS_PROBE="$PWD/apps/gateway/dist/pirc-macos-probe" \
PIRC_TEST_GATEWAY_FORGED="$PWD/apps/gateway/dist/pirc-forged-worker" \
PIRC_TEST_GATEWAY_FORGED_BOOTSTRAP="$PWD/apps/gateway/dist/pirc-forged-bootstrap.dylib" \
PIRC_TEST_GATEWAY_MEMORY_PROBE="$PWD/apps/gateway/dist/pirc-memory-probe" \
PIRC_TEST_GATEWAY_FORK_PROBE="$PWD/apps/gateway/dist/pirc-fork-probe" \
PIRC_TEST_GATEWAY_MACOS_PORTS="$PWD/apps/gateway/dist/pirc-worker-ports-probe" \
PIRC_TEST_GATEWAY_MACOS_STALL="$PWD/apps/gateway/dist/pirc-worker-stall-probe" \
  bun test apps/gateway/test/gateway-worker-isolation.test.ts \
    apps/gateway/test/gateway-worker-macos-ports.test.ts \
    apps/gateway/test/gateway-worker-macos-lifecycle.test.ts \
    apps/gateway/test/gateway-agent-runtime.test.ts \
    apps/gateway/test/environment-transport.integration.test.ts \
    apps/gateway/test/gateway-session-authority.test.ts \
    apps/gateway/test/gateway-turn-lifecycle.test.ts \
    apps/gateway/test/gateway-node-fences.integration.test.ts

PIRC_TEST_GATEWAY_WORKER="$PWD/apps/gateway/dist/pirc-runtime-worker" \
  bun test apps/gateway/test/gateway-worker-macos-protocol.test.ts

cd apps/gateway
PIRC_TEST_SRT=embedded bun test test/environment-*.test.ts test/sandbox-srt.integration.test.ts
```

| Verification                                                     | Result                                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| macOS finite worker/runtime/authority/lifecycle/transport/fences | **44 pass / 1 Linux-only skip / 0 fail; 382 assertions**                                                                                 |
| macOS native protocol-only suite                                 | **28 pass / 0 fail; 110 assertions**                                                                                                     |
| macOS Environment/real-srt suite                                 | **77 pass / 2 skip / 0 fail; 486 assertions**                                                                                            |
| Linux real worker/runtime/fences/transport                       | **23 pass / 3 macOS-only skip / 0 fail; 185 assertions**                                                                                 |
| Linux focused Environment/runtime regressions                    | **30 pass / 8 opt-in skip / 0 fail; 209 assertions**                                                                                     |
| Linux full `bun run check`                                       | Passed: **1073 gateway pass / 166 skip / 0 fail**, **284 Web pass**, **121 compiled-role pass**; version/format/typechecks/builds passed |
| macOS full `bun run check` with real-srt/native opt-ins          | Passed: **1125 gateway pass / 112 skip / 0 fail**, **284 Web pass**, **121 compiled-role pass**; version/format/typechecks/builds passed |

The macOS full check ran with the native fixture paths above, `PIRC_TEST_SRT=embedded`
and `NODE_OPTIONS=--no-experimental-webstorage`; its own phase exit status was 0.
It included real native containment, protocol/lifecycle, combined real-srt recovery,
all repository check stages and Darwin builds, not just ordinary skipped opt-ins.

The Environment skips are delegated Linux cgroups and opt-in small-filesystem
ENOSPC, not successful platform checks. Historical ENOSPC and delegated-cgroup
records remain separate. No real provider evaluation, Android device check,
manual browser check, M5 performance comparison or production cutover ran.
Nix packaging includes the Darwin native driver, bootstrap, inspection and
watchdog assets; `nix-instantiate --parse nix/package.nix` passed. No Darwin Nix
build or Nix package containment test was run.

Raw commands and logs, including failed intermediate attempts, remain in the
remote disposable validation directory and the initiating checkout's ignored
`work/` evidence directories. This record credits only the final passing
configuration; background SSH wrapper status is not a substitute for each test
phase's own exit status and summary.
