# Architecture references

[All documentation](../README.md) · [Current topology](../deploy/topology.md)

| Reference                                                                       | Covers                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Model backends and authentication](backend-auth.md)                            | Gateway-owned inference and provider credentials, subscription-login workers and trust boundaries |
| [Observational memory](observational-memory.md)                                 | Session/workspace memory, extraction, storage, recall and validation                              |
| [Prompt and Context contracts](prompt-context.md)                               | Prompt sections, assistant configuration, node-local snapshots and authorized relays              |
| [Session activity and list updates](../guides/session-ui.md#activity-transport) | Node activity, session origins and client updates                                                 |

The [gateway agent runtime plan](../../plans/gateway-agent-runtime.md) proposes a different topology. It is accepted as a plan only; implementation and deployment cutover are not authorized, and it must not be read as the current architecture.

Historical feature designs live in [history](../history/README.md); the accepted hybrid tool migration and its evidence live in [PTC evaluations](../evaluations/ptc/README.md).
