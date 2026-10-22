---
label: Scratch
description: One-off work in a fresh directory, without a repository.
ui:
  noun: session
# Each session gets its own empty directory, kept a while and then removed
# (PIRC_SCRATCH_RETENTION_DAYS on the node).
workdir: per-session
prompt:
  - base
  - agents:global
  - body
features_off: []
features_on: []
# null allows the node's normal tools; [] allows none.
tools: null
delegate_target: true
project_config: false
workspace_memory: false
repository: false
recap: false
---

Work in this session's own directory. It is not a repository and is removed
some days after the work ends: report what matters, and keep nothing there
you need later.
