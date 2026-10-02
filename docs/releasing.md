# Versioning and releases

## One product version

The root `package.json` is the version authority. Gateway, chat, node, web, Android `versionName`, and Nix packages share it. CLI binaries and Nix read it directly; the two workspace manifests and Android fields are synchronized by `bun run version:bump <version>`. Android `versionCode` increases by one for every product release, whether or not that release includes an APK. Never reuse a published version or Android code.

Only release commits bump versions. Normal feature/fix commits update `CHANGELOG.md` under **Unreleased** when they affect users. Document impact and migration, not an exhaustive git log. Do not fabricate historical releases.

| Change                                               | Before 1.0                       | From 1.0                |
| ---------------------------------------------------- | -------------------------------- | ----------------------- |
| Compatible fixes, security fixes, small improvements | PATCH                            | PATCH                   |
| New functionality                                    | MINOR                            | MINOR                   |
| Breaking changes or required migration               | MINOR + explicit migration notes | MAJOR + migration notes |
| Docs/tests/internal refactors only                   | No release required              | No release required     |

Use stable `MAJOR.MINOR.PATCH` versions and annotated `vMAJOR.MINOR.PATCH` tags. The helper deliberately does not support prereleases yet. A batch uses the highest required bump. Conventional Commits help identify changes, but release notes are reviewed by a human/agent, not copied automatically from commit subjects. Start 1.0 when ready to promise a stable compatibility contract.

## Independent compatibility counters

- `NODE_PROTOCOL_VERSION` changes only for incompatible gateway/node transport changes. Such upgrades require all nodes and the gateway to move together.
- SQLite schema migrations keep their own ordered migration numbers. A product version does not imply rollback compatibility; back up state before upgrades.
- Android `versionCode` is an install/update counter, not SemVer.

## Release checklist

1. Confirm the target repository/branch, clean working tree, release scope, and available platform validation. Check remote tags/releases first.
2. Review **Unreleased**, move its entries to `## [<version>] - YYYY-MM-DD`, and leave an empty Unreleased section. Include breaking changes, migration instructions, security notes, and known limits. Do not backdate a release or describe unverified platform builds as tested.
3. Run `bun run version:bump <version>`, then `bun install --lockfile-only` and `bun run version:check`. Review the diff: dependency resolutions must not change merely to release.
4. Run `bun run check`. For Nix changes run `nixfmt --check nix/package.nix` and syntax/evaluation checks as available. If publishing an APK, also run Android unit tests/build and use the established signing identity; never substitute a debug APK for a signed release.
5. Review and commit only release-owned changes with `chore(repo/release): release v<version>`.
6. Build/package only from the committed, clean tree. For local macOS ARM64 assets, set `PIRC_RELEASE_BUN` to an absolute path to official Bun and `PIRC_RELEASE_BUN_LICENSE` to that Bun release's `LICENSE.md`, then run `bun scripts/package-release.ts` (requires Python 3). It exports the committed tree with `git archive`, installs frozen dependencies and rebuilds in a fresh directory, checks versions and native dependencies, then writes archives/checksums under ignored `dist/releases/`. `BUILD.json` records the commit, compiler version/digest and commit epoch; tar/gzip metadata is normalized. This does not promise byte-identical compiler output across hosts. Inspect archive contents and smoke-test extracted binaries. Never include local config, state, credentials, or host-specific deployment notes.
7. Create the annotated tag on that exact commit. Push without force, preferably atomically: `git push --atomic origin main v<version>`. If the remote moved, stop and reconcile rather than overwrite it.
8. Create a **draft** GitHub release for the existing tag (`--verify-tag`) with the reviewed changelog entry and intended assets. Verify asset names, checksums, tag commit and release notes, then publish. Do not silently replace published assets/tags; corrections get a new release.
9. Verify the public release URL and uploaded assets; report any skipped platforms/checks. Publishing a release does not deploy it to running hosts.

## Native macOS archive

The archive includes the three compiled executables, launch wrappers, Playwright runtime data, web static files, documentation and third-party notices. Wrappers locate their runtime data relative to the extracted directory. Chromium is **not** bundled: install a compatible Chromium/Chrome separately and configure `PIRC_BROWSER_EXECUTABLE`; optional recording needs ffmpeg. The built-in macOS sandbox uses `/usr/bin/sandbox-exec`. The gateway requires the usual authenticated reverse proxy; web assets are served by that proxy (not embedded by the gateway).

These local binaries are not Developer ID signed or notarized. They are macOS ARM64 artifacts only, not Linux/x86_64 builds or an Android APK. Source archives remain available from GitHub, and Nix packaging remains supported. Read [deployment documentation](deploy/README.md) and [upgrades](deploy/upgrades.md) before running them.
