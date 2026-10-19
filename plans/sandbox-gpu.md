# GPU access in the agent sandbox

[Plans](README.md) · [Sandbox and browser](../docs/deploy/sandbox-and-browser.md) · [Security decisions](../docs/architecture/security-decisions.md)

Goal: an opt-in, node-local setting lets sandboxed agents use the GPU (PyTorch MPS on macOS, CUDA on NVIDIA, render nodes on AMD/Intel), so GPU workloads such as a throwaway ComfyUI no longer escape through `unsandboxed_bash`. Nothing else in the sandbox widens.

This file is the work queue for the change, not authorization: each phase needs the user's go-ahead. It changes a security boundary; the decision and its limits go into [Security decisions](../docs/architecture/security-decisions.md) with the implementation.

## Why

A delegated "deploy ComfyUI and draw" task asked for approval at almost every step. Two sandbox layers caused it, not auto mode:

1. **No GPU inside the sandbox.** Agents then run GPU work through `unsandboxed_bash`, which always asks. The failure is misleading: PyTorch reports `The MPS backend is supported on macOS 14.0+` rather than a permission error, so the agent cannot tell that the sandbox is the cause.
2. **Model hosts are not default domains.** Hugging Face, Civitai, `download.pytorch.org` and their CDN redirect hosts each need `sandbox_allow_domains`, approved per session, so every new delegated session asks again. This needs no code: lasting allows belong in `sandbox.network.allowedDomains` (see "Accepted limitations" in [Plans](README.md)). The deploy guide gains an example (phase 3); the exact CDN host names must come from recorded approvals, not guesses.

## Evidence (macOS, measured 2026-10-19)

Host: M5 Pro, macOS 26.5.1. Method: the recorded production profile `crates/pirc-node/tests/fixtures/sbpl/pirc/session.sb` (same `base.sb`) with its placeholders filled, run with `sandbox-exec`, plus `/private/tmp` writable to match production's `tmp_dirs` (`sandbox/common.rs`). Not a running node; probes and profiles were kept in `/tmp/gpuprobe` (scratch, not committed).

| Profile                             | Swift Metal probe (runtime-compiled kernel + dispatch)                   | PyTorch 2.14.1 MPS 4096² matmul | diffusers tiny Stable Diffusion, MPS, 20 steps    |
| ----------------------------------- | ------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------- |
| Current                             | No devices (`MTLCopyAllDevices` empty)                                   | `mps available: False`          | Fails (`MPS backend is supported on macOS 14.0+`) |
| + `AGXDeviceUserClient`             | Device found; runtime compile fails (`MTLCompilerService` lookup denied) | —                               | —                                                 |
| + `MTLCompilerService` (both rules) | OK                                                                       | OK                              | OK, 5.0 s (one run)                               |
| + shader/MPSGraph cache writes      | OK                                                                       | OK                              | OK, 2.9 s (one run)                               |

The two required rules:

```scheme
(allow iokit-open-user-client (iokit-user-client-class "AGXDeviceUserClient"))
(allow mach-lookup (xpc-service-name "com.apple.MTLCompilerService")
                   (global-name "com.apple.MTLCompilerService"))
```

Without the optional cache rules, Metal and MPSGraph work but log denied writes to `$DARWIN_USER_CACHE_DIR/com.apple.{metal,metalfe,gpuarchiver}` and `$DARWIN_USER_TEMP_DIR/com.apple.MetalPerformanceShadersGraph`, and recompile shaders each process. These directories are shared with every other program of the node account, so writing them could plant cache contents other programs load. Remaining denials (`windowserver`, `tccd`, `DiskArbitration`, `coreservicesd`, `analyticsd`, a few sysctls) also occur without GPU work and were not needed.

## Linux research (unverified on real hardware)

From NVIDIA libnvidia-container ([`nvc_mount.c`](https://github.com/NVIDIA/libnvidia-container/blob/main/src/nvc_mount.c), [`nvc_info.c`](https://github.com/NVIDIA/libnvidia-container/blob/main/src/nvc_info.c)), the [PyTorch missing-UVM report](https://github.com/NVIDIA/nvidia-container-toolkit/issues/50), [MIG device nodes](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/latest/device-nodes-and-capabilities.html), [Flatpak](https://github.com/flatpak/flatpak/blob/main/common/flatpak-run.c), [ROCm in containers](https://rocm.docs.amd.com/projects/install-on-linux/en/docs-7.2.3/how-to/docker.html) and [bubblewrap](https://github.com/containers/bubblewrap/blob/main/bubblewrap.c):

- **Order.** `finish()` in `crates/pirc-node/src/sandbox/linux.rs` adds `--dev /dev`, a fresh minimal devtmpfs; device binds must come after it or are hidden.
- **NVIDIA compute:** `--dev-bind` `/dev/nvidiactl`, each selected `/dev/nvidia<N>` (never a glob) and `/dev/nvidia-uvm` (without it `nvidia-smi` works but PyTorch reports no CUDA); `--dev-bind-try /dev/nvidia-uvm-tools`. Omit `/dev/nvidia-modeset` (display) and `/dev/nvidia-caps/*` (MIG/management). UVM nodes may be created lazily: the host must provision them before planning (e.g. `nvidia-modprobe -u -c=0`); a node appearing later does not reach an existing sandbox.
- **AMD/Intel:** selected `/dev/dri/renderD<N>` only, never `card*`; ROCm adds `/dev/kfd`, which is shared across GPUs.
- **Nothing else to mount.** `--proc` shows the global `/proc/driver/nvidia`; `/sys` and driver libraries are readable through `--ro-bind / /`. NixOS drivers live in `/run/opengl-driver/lib` (readable); applications without a suitable RUNPATH may need it prepended to `LD_LIBRARY_PATH`. The seccomp filter (vsock, io_uring, 32-bit) and network namespace need no change; keep `nvidia-persistenced` and other management sockets hidden.
- **Permissions.** The node account itself needs access to the device nodes (commonly `video`/`render`). Unprivileged bubblewrap keeps supplementary groups (shown as 65534 inside); no capabilities or GID mappings are added.
- **NixOS module blocks it today.** `nix/module.nix` runs the node with `PrivateDevices = true` (shared `hardening`), so the node process, and every sandbox it starts, sees no GPU device at all. `ProtectKernelModules = true` also prevents loading `nvidia-uvm` from the service: provision on the host.

## Configuration

In the node's `$PIRC_CONFIG_DIR/config.json` only, never a project's `.pirc/config.json`:

```json
{
  "sandbox": {
    "gpu": {
      "enabled": false,
      "devices": [],
      "shaderCache": false
    }
  }
}
```

- `enabled` (default false). macOS: adds the two Metal rules. Linux: requires a nonempty `devices`.
- `devices` (Linux only; a nonempty list on macOS is a warning). Exact paths matching `/dev/nvidia<N>`, `/dev/dri/renderD<N>` or `/dev/kfd`. Any `/dev/nvidia<N>` implies `/dev/nvidiactl`, `/dev/nvidia-uvm` and (try) `/dev/nvidia-uvm-tools`. Globs, `card*`, `nvidia-modeset`, `nvidia-caps` and other paths are validation errors.
- `shaderCache` (macOS only, default false): also allow the Metal and MPSGraph cache directories above, resolved with `confstr(_CS_DARWIN_USER_CACHE_DIR / _CS_DARWIN_USER_TEMP_DIR)` at planning time.
- As with the rest of `sandbox`, an invalid object keeps the defaults (GPU off) and warns in every session.

## Phase 1 — macOS

- [ ] `pirc-policy` `SandboxConfig` gains `gpu` with the validation above (`crates/pirc-policy/src/session.rs` schema and known-key list).
- [ ] `ProfileInput` gains GPU access; `profile::generate` emits the two rules (and the cache subpaths when `shaderCache`) as one marked section after the IOKit block (`crates/pirc-node/src/sandbox/macos/profile.rs`, `macos.rs` `policy_profile`). Read-only profiles (Git panel) never get it.
- [ ] Fixture `tests/fixtures/sbpl/pirc/gpu.sb` (+ `pirc-cases.json` entry) recorded with `PIRC_BLESS_SBPL=1` and reviewed by hand; existing recordings must not change.
- [ ] Native test in `crates/pirc-node/tests/sandbox_macos.rs`: compile the Swift Metal probe with `xcrun swiftc` (skip with a reason when unavailable or on a GPU-less runner) and assert it fails without and succeeds with GPU access.
- [ ] Agent prompt (`crates/pirc-agent/src/features/sandbox.rs`): say whether the GPU is available inside the sandbox. When it is not: GPU frameworks will report odd errors (e.g. the MPS "macOS 14.0+" message); ask the user to enable `sandbox.gpu` rather than running GPU work through `unsandboxed_bash`. Refresh the affected conformance prompt snapshots after review.

## Phase 2 — Linux

- [ ] At planning time, each configured device (and implied NVIDIA node) must exist and be a character device; append `--dev-bind`/`--dev-bind-try` after `finish()`'s `--dev /dev`. A unit test pins the order (`linux.rs` tests near the existing `--dev`/`--proc` assertions) and that unconfigured nodes never get device binds.
- [ ] A missing required device: start the agent without GPU access and report it in the session warning and the prompt (decision below).
- [ ] NixOS module: an option (e.g. `gpu.devices`) that, for the node service only, replaces `PrivateDevices = true` with `PrivateDevices = false`, `DevicePolicy = "closed"` and `DeviceAllow` entries for exactly those devices, adds the needed supplementary groups, and writes the matching `sandbox.gpu` into the node config. The gateway keeps its hardening.
- [ ] Optionally prepend `/run/opengl-driver/lib` to `LD_LIBRARY_PATH` inside GPU sessions on NixOS, preserving existing entries (decide after hardware testing).

## Phase 3 — Docs and decision

- [ ] `docs/deploy/sandbox-and-browser.md`: the `gpu` settings, host preparation (UVM provisioning, groups, NixOS option) and an `allowedDomains` example for model hosts.
- [ ] `docs/architecture/security-decisions.md`: GPU access is opt-in node trust, not isolation. It exposes a large kernel-driver attack surface, shared GPU memory/resource exhaustion and global utilization metadata; vendor memory-clearing bugs exist (e.g. [LeftoverLocals](https://blog.trailofbits.com/2024/01/16/leftoverlocals-listening-to-llm-responses-through-leaked-gpu-local-memory/)). `shaderCache` shares writable caches with the node account's other programs.
- [ ] `CHANGELOG.md`.

## Manual validation (unverified until done)

- **NVIDIA (NixOS):** in the host and in the real pirc-generated bubblewrap invocation, `nvidia-smi` and `python -c 'import torch; print(torch.version.cuda, torch.cuda.is_available()); x=torch.ones(16,device="cuda"); print((x*x).sum().item())'`. Negative checks: GPU off fails CUDA; `card*`, modeset, caps and persistence sockets stay absent; network and filesystem denials unchanged.
- **AMD/Intel:** a Vulkan or ROCm smoke test on a render node, if hardware is available.
- **macOS:** a full delegated ComfyUI session on a real node with `gpu.enabled`, counting the approvals that remain.

## Decisions needed

1. Missing configured device on Linux: start without GPU and warn (recommended: the agent still works), or refuse to start the session.
2. `shaderCache`: ship it (off by default) or leave caches denied entirely.

Teammates and subagents share their parent's sandbox, so they get GPU access with it; no separate setting.
