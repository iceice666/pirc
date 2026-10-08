# Implementation history

[All documentation](../README.md) · [Active plans](../../plans/README.md) · [Cross-feature backlog](../../plans/backlog.md)

These are dated design and implementation records, not current deployment instructions. Original decisions, superseded proposals and validation limitations are retained for provenance. Current behavior is described in the [user guides](../guides/README.md) and [deployment guides](../deploy/README.md).

| Record                                          | Recorded implementation                                          | Remaining work                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Assistant memory and delegation](assistant.md) | v1 memory, delegation, search and later role ownership           | [Assistant roadmap](../../plans/assistant.md)                                                            |
| [Browser](browser.md)                           | Browser tools, live view, takeover and recording                 | [Browser follow-ups](../../plans/backlog.md#browser)                                                     |
| [Scheduled runs](cron.md)                       | Gateway scheduling, web/Android UI and push                      | [Schedule follow-ups](../../plans/backlog.md#schedules)                                                  |
| [Android client](android-client.md)             | Pairing, chat, files and additional panels                       | [Android follow-ups](../../plans/backlog.md#android) and [mobile audit](../../plans/mobile-audit.md)     |
| [Sandbox](sandbox.md)                           | Mandatory fail-closed agent sandbox and host execution approvals | [Sandbox follow-ups](../../plans/backlog.md#sandbox) and [security audit](../../plans/security-audit.md) |

## Consolidated completed plans

Two completed plans were retired after their useful contracts and unresolved items were preserved:

- Prompt customization (implemented 2026-10-02, baseline `69ae62c`): [Prompt/Context contracts](../architecture/prompt-context.md), [user-facing instructions](../guides/chat-projects.md), and the [Android inspector decision](../../plans/backlog.md#android).
- UI redesign (implemented 2026-09-29, commits `4ce2c40`, `4a3e46f`, `ea76001`): [Session UI and activity contract](../guides/session-ui.md). Obsolete mock-layout discussion is no longer maintained.

The [PTC archive](../evaluations/ptc/README.md) is separate because its protocols and aggregate evidence are also consumed by evaluation/report scripts.
