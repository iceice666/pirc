# Cross-feature follow-ups

A compact locator for outstanding validation, accepted limitations and product decisions recorded in completed designs. Items are not new implementation, deployment, paid-evaluation or completion authorization. Historical statements retain their source date; do not infer that later work resolved them without evidence.

Active detailed lists remain authoritative: [Assistant roadmap](assistant.md), [Project isolation](project-isolation.md), [Mobile audit](mobile-audit.md), and [Security audit](security-audit.md). They are linked, not duplicated here.

## Browser

Source: [built browser design and follow-ups](../docs/history/browser.md#follow-ups-not-done).

- **Validation:** real Linux node with nixpkgs Chromium/CDP compatibility and full Nix build; real Android takeover (tap mapping, IME, drag scrolling) and WebM playback.
- **Proposal:** non-localhost browser click/type classification, coordinated with the Assistant network-taint work.
- **Limitations:** teammates/subagents have no browser; shared access would need locks or separate tab groups. The screenshot action log is memory-only and lost on node restart; recordings persist. Page results are fenced untrusted but observational-memory provenance tagging remains incomplete in the recorded design.

## Schedules

Source: [schedule follow-ups](../docs/history/cron.md#follow-ups).

- **Validation:** installed-PWA push on a real iPhone; iOS Safari requires Add to Home Screen.
- **Upgrade requirement, not a feature task:** deploy gateway and nodes together for the changed deliver body (`scheduled-run`, `model`, `thinking`). See [Upgrades](../docs/deploy/upgrades.md).

## Android

Sources: [client milestones/open questions](../docs/history/android-client.md#milestones) and the [preserved Context contract](../docs/architecture/prompt-context.md).

- **Remaining milestone scope:** polish (motion, copy menus, large-font/small-screen passes) and release signing. This summary does not mark milestone 6 complete.
- **Decisions:** token rotation before the 30-day limit versus monthly re-pairing; sideload-only distribution versus F-Droid/Play.
- **Decision:** add the native Android Context inspector later or never; it was not included in the completed web inspector milestone.
- Detailed mobile UI/parity work remains in the [Mobile audit](mobile-audit.md).

## Sandbox

Source: [sandbox follow-ups](../docs/history/sandbox.md#follow-ups).

- **Real NixOS validation:** bubblewrap under unit hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateDevices`); tmpfiles handover of an existing `/var/lib/pirc/daemon`; `apiKeyFile` ownership after migration to `pirc-gateway`.
- **Real Linux validation:** bundled srt finding extracted `apply-seccomp` inside the namespace.
- **Limitations/proposals:** known host sockets are hidden, but other account-accessible Unix sockets remain reachable; move inference off Unix sockets or narrowly bind-mount it. Workspace-memory's whole-directory writability permits appends to other repositories' ledgers. Approvals are session-only; workspace-persistent grants do not exist.
- The launchd `agent.env` protection bullet records a 2026-10-07 fix, not unresolved work. Do not re-open it from the historical list.

## Accepted PTC follow-ups and release checks

Source: [accepted hybrid migration and Milestone 4 review](../docs/evaluations/ptc/ptc-only.md). These P3 items were explicitly accepted, not blockers silently left over from an unaccepted PTC-only cutover.

### Accepted limitations

- Bash writes via a symlink created in the same command under shared roots can skip the write lease (coordination, not authority).
- `bash curl`, `agent_inbox`, `delegation_status` and `memory_search` output lacks untrusted tagging, as with prior direct calls.
- Guests inherit agent sandbox rights rather than a stricter no-network/no-write profile.
- The prompt's approval convention is host-gated but does not enumerate those operations; chat scripting uses the same budgets.
- Operations ignoring abort may outlive the script beyond the five-second grace and report after the turn.
- After an agent crash mid-script, the model sees interrupted rather than the completed-operation inventory.
- Progress includes queued operations; eight long waits can occupy all slots until script timeout.

### Manual real-runtime checks before release

- Node/agent crash during a spinning script: orphaned guest exits; also test a team child crashing mid-script.
- Decline node sandbox approvals (`unsandboxed_bash`, `sandbox_allow_domains`) in web and Android and observe the host-written `[declined]` section.
- Relay script screenshot attachments through a real node.
- Exercise direct calls containing optional `null` and extra arguments with real Anthropic and OpenAI-compatible providers.
- Verify web/Android rendering of `[declined]`, `[hooks]`, and bounded operation arguments.

The reviewed fixes changed behavior and two prompts after the evaluated builds; no paid re-measurement was recorded. Preserve that limitation, the existing aggregate evidence, historical failed/incomplete verdicts, budgets and attempt markers. This backlog does not authorize another run.
