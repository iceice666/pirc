# Versioning and releases

## One product version

The root `package.json` is the product version authority. Gateway, chat, node, web, the Flutter Android app, and Nix packages share its SemVer version. Rust binaries read the Cargo workspace version; the web manifest, Cargo workspace/lockfile, and Flutter app manifest are synchronized by `bun run version:bump <version>`. The Flutter app's `apps/android/pubspec.yaml` is the sole Android version metadata source: its SemVer must match the product version, and its `+<build>` number is the Android `versionCode`, incremented once for every product release whether or not that release includes an APK. Never reuse a published version or Android build number.

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
3. Run `bun run version:bump <version>`, then `bun install --lockfile-only`, `cargo update --workspace` (the Rust workspace in `crates/` shares the version) and `bun run version:check`. The helper also increments the Flutter manifest's Android build number. Review the diff: dependency resolutions must not change merely to release. The version lines in `Cargo.lock` change the vendored dependency set, so refresh `cargoHash` in `nix/package.nix` too (build `.#pirc-gateway.cargoDeps` and take the hash it reports); CI's Nix job fails until it matches.
4. Run `bun run check`. For Nix changes run `nixfmt --check nix/package.nix` and syntax/evaluation checks as available. If publishing an APK, run the Flutter analysis and Android JVM tests, build a release APK, and use the established signing identity; never substitute a debug APK for a signed release. Geometry-dependent Flutter widget tests require Arial/Menlo and are not run by the Linux Android workflow; validate those on macOS when they are in scope.
5. Review and commit only release-owned changes with `chore(repo/release): release v<version>`.
6. Build/package only from the committed, clean tree. For local macOS ARM64 assets, install a native Rust toolchain and Apple command-line tools, set `PIRC_RELEASE_CARGO` to cargo's absolute path, then run `bun scripts/package-release.ts` (requires Python 3). It exports the committed tree with `git archive`, installs frozen dependencies and rebuilds in a fresh directory, checks versions and native dependencies, then writes archives/checksums under ignored `dist/releases/`. `BUILD.json` records the commit, Rust/Cargo/Bun versions, binary byte counts and commit epoch; tar/gzip metadata is normalized. This does not promise byte-identical compiler output across hosts. Inspect archive contents and smoke-test extracted binaries. Never include local config, state, credentials, or host-specific deployment notes.
7. Create the annotated tag on that exact commit. Push without force, preferably atomically: `git push --atomic origin main v<version>`. If the remote moved, stop and reconcile rather than overwrite it.
8. Create a **draft** GitHub release for the existing tag (`--verify-tag`) with the reviewed changelog entry and intended assets. Verify asset names, checksums, tag commit and release notes, then publish. Do not silently replace published assets/tags; corrections get a new release.
9. Verify the public release URL and uploaded assets; report any skipped platforms/checks. Publishing a release does not deploy it to running hosts.

## Native macOS archive

The archive includes two native executables (`pirc-gateway`, `pirc-node`), web static files, documentation and third-party notices from locked Cargo dependencies and web/build packages. Chat is `pirc-node chat`. There are no launch wrappers, Playwright runtime package, Bun/Node runtime or JS sidecar. Bun is used only to build the web assets. Embedded browser scripts retain their Apache notices. Chromium is **not** bundled: install a compatible Chromium/Chrome separately and configure `PIRC_BROWSER_EXECUTABLE`; optional recording needs ffmpeg. The built-in macOS sandbox uses `/usr/bin/sandbox-exec`. The gateway requires the usual authenticated reverse proxy; web assets are served by that proxy (not embedded by the gateway).

These local binaries are not Developer ID signed or notarized. They are macOS ARM64 artifacts only, not Linux/x86_64 builds or an Android APK. Source archives remain available from GitHub, and Nix packaging remains supported. Read [deployment documentation](../deploy/README.md) and [upgrades](../deploy/upgrades.md) before running them.

## GitHub Release CI setup (once per repository)

The **Release** workflow builds the existing macOS ARM64 and Web archives plus a
signed Android beta APK. It creates a **draft**, never publishes automatically.
It does not bump versions, create tags, deploy servers or replace an existing
release. All actions/toolchains are pinned. macOS runs use GitHub's
[ARM64 `macos-15` runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

1. Enable GitHub Actions in the repository. Its Actions policy must allow the
   pinned actions in `.github/workflows/release.yml`. The workflow requests
   `contents: write` only for the final draft job and `actions: read` for checking
   the exact commit's tests. If organization policy restricts these permissions,
   a repository/organization administrator must allow them. No personal access
   token is needed in repository secrets.
2. Choose and securely back up a **persistent** Android signing keystore. To keep
   updates compatible with the already distributed preview APK, use its original
   signing identity; a different key requires uninstalling the old preview app
   (and can remove its local data). Do not generate a fresh key on every run. The
   application ID remains `dev.pirc.mobile.preview`; this is beta sideload
   distribution, not Play Store signing or production certification.
3. Add these repository Actions secrets (**Settings → Secrets and variables →
   Actions**), or use the GitHub CLI commands below. Never commit a keystore,
   password, base64 key, `key.properties` or local machine path.

   | Secret                    | Value                                              |
   | ------------------------- | -------------------------------------------------- |
   | `ANDROID_KEYSTORE_BASE64` | Base64 of the chosen keystore, without line breaks |
   | `ANDROID_STORE_PASSWORD`  | Keystore password                                  |
   | `ANDROID_KEY_ALIAS`       | Private key alias                                  |
   | `ANDROID_KEY_PASSWORD`    | Private key password                               |

   From a trusted local terminal with `gh auth login` already complete:

   ```sh
   # Replace the path; the encoded key goes directly to gh, not a file/log.
   base64 < /secure/path/pirc-preview.keystore | tr -d '\r\n' | gh secret set ANDROID_KEYSTORE_BASE64 --repo iceice666/pirc
   # Each command prompts privately; do not put passwords in shell arguments.
   gh secret set ANDROID_STORE_PASSWORD --repo iceice666/pirc
   gh secret set ANDROID_KEY_ALIAS --repo iceice666/pirc
   gh secret set ANDROID_KEY_PASSWORD --repo iceice666/pirc
   ```

4. Run **Actions → Release setup → Run workflow** on `main` (or
   `gh workflow run release-setup.yml --ref main --repo iceice666/pirc`). It decodes
   the key in runner temporary storage, validates both passwords and the private
   key alias, and reports the public signing certificate SHA-256. Compare this
   with the installed/published preview's certificate before enabling upgrades.
   Temporary key material is deleted even on failure. Setup does not upload an
   APK, create a release, generate a replacement key or publish secrets.
5. Resolve failures before tagging a release. Missing secrets fail explicitly;
   release CI never silently falls back to a newly generated debug key. Local
   preview builds keep their existing signing behavior when CI variables are not
   set. The setup check does not prove physical-device acceptance.

The original repository's dedicated release key was configured on 2026-10-19;
[Release setup passed](https://github.com/iceice666/pirc/actions/runs/39224437750).
Its public certificate SHA-256 is
`f612b5ff5a6f60155debbaa671e2d0ca9248d75d16f65dc64fcd11f7c99f9d81`.
This intentionally replaces the debug identity used by the initial 0.6.1 beta;
that beta must be uninstalled before installing an APK signed with the new key.
The application ID is still the preview ID. Local builds without CI signing
variables still use the debug key. Forks must configure their own secrets.

## Running the Release workflow

1. Follow checklist steps 1–6 above, including version/build-number increments,
   changelog review and local tests. Push the release commit to `main` **first**.
   Wait for that exact commit's **Check** workflow and **Android** workflow to
   pass. Older green checks or pull-request results do not satisfy this gate.
2. Create an annotated `vMAJOR.MINOR.PATCH` tag on that tested commit and push the
   tag. This starts **Release**, including Android by default. Do not atomically
   push a new commit and its tag for this CI path: the commit's checks must already
   be green. Release CI requires the tag commit to be in `origin/main`, all
   manifests/locks to agree, and a nonempty dated changelog entry for the version.
3. For an existing annotated tag, use **Actions → Release → Run workflow** on
   `main`, enter the tag and choose whether to include Android. CLI equivalent:

   ```sh
   gh workflow run release.yml --ref main --repo iceice666/pirc -f tag=v0.8.0 -F android=true
   ```

   The version is an example; choose the actual next reviewed version. Disabling
   Android produces only native/Web assets and does not require signing secrets.
   Do not reuse an existing published version or Android build number.

4. The native job packages only committed source via `scripts/package-release.ts`
   and smoke-tests extracted binary versions. The Android job uses Flutter 3.44.4,
   analysis, macOS font-dependent Flutter tests, JVM tests, release APK
   compilation and the ML Kit reflected-constructor check. Final assembly checks
   the exact asset set and hashes the downloaded bytes into a single `SHA256SUMS`:
   - `pirc-v<version>-darwin-arm64.tar.gz`
   - `pirc-web-v<version>.tar.gz`
   - `pirc-<version>-beta.apk` (when requested)
   - `SHA256SUMS`

5. Review the draft's changelog notes, tag commit, assets and signing certificate.
   Publish manually in GitHub after acceptance. Existing drafts/releases are not
   overwritten. A build failure creates no draft; CI artifacts expire after seven
   days. If draft creation/upload is interrupted, inspect and remove only that
   incomplete **draft** before retrying. Never delete/replace a published release
   to work around a failure; use a new version. If a tag was pushed before its
   checks completed, wait for green checks and rerun; do not move the tag.

Creating workflows is separate from configuring repository secrets. The setup
workflow must succeed in the target repository before the first signed Android
CI release; no signing key is provisioned by committing this documentation.
