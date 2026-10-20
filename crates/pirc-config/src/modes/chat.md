---
label: Chat
description: The personal assistant's chats and projects.
ui:
  noun: chat
# Transitional host restriction until nodes accept explicit mode ids.
workdir: per-session
prompt:
  - soul
  - chat-env
  - chat-md
  - body
features_off: [goal, todo, agentTeam, background]
features_on: []
# null allows the node's normal tools; [] allows none.
tools: null
assistant: full
delegate: true
delegate_target: false
project_instructions: true
project_files: true
project_config: false
workspace_memory: false
repository: false
recap: false
delete_sessions: true
projects: true
---
