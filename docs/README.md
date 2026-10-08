# Documentation

Start with the [project README](../README.md) for the security model, requirements and development quickstart. This directory separates current usage from implementation references and historical decisions.

| I want to…                                             | Start here                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| Configure or use an agent                              | [User guides](guides/README.md)                                             |
| Deploy, upgrade or recover an installation             | [Deployment guide](deploy/README.md)                                        |
| Understand implementation boundaries                   | [Architecture references](architecture/README.md)                           |
| Build a release                                        | [Release policy](development/releasing.md) and [changelog](../CHANGELOG.md) |
| Find work that remains                                 | [Active plans and follow-ups](../plans/README.md)                           |
| Understand an earlier design decision                  | [Implementation history](history/README.md)                                 |
| Inspect PTC baseline, comparison protocols and results | [PTC evaluation archive](evaluations/ptc/README.md)                         |

## Development and package references

- [Gateway and node development/API](../apps/gateway/README.md)
- [Web client](../apps/web/README.md)
- [Android client](../apps/android/README.md)
- [Nix packaging and module](../nix/README.md)
- [Timeline fixtures](../fixtures/timeline/README.md)

## Where information belongs

- **`guides/`** explains current user-facing behavior and configuration. Use **`deploy/`** for host setup, environment variables and operations.
- **`architecture/`** explains implementation contracts and trust/storage boundaries; keep its stated verification scope and dates in mind.
- **`../plans/`** contains unimplemented proposals, unresolved audits and follow-ups. A plan is not authorization to implement or deploy it.
- **`history/`** preserves dated implementation records. Old flags, version numbers and proposals are not current setup instructions.
- **`evaluations/ptc/`** preserves protocols, chronological decisions and aggregate evidence. Historical paid-run approvals are not permission to rerun an evaluation.

When a plan completes, move its durable implementation record to the appropriate documentation area and retain unresolved work in the plans index or backlog. Link to the owning document rather than copying its status into multiple pages. Update relative links and any scripts that read moved artifacts. Preserve evaluation JSON bytes and recorded failed/incomplete outcomes.
