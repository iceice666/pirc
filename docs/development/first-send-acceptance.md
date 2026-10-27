# First-send live client acceptance

The first-send flow remains disabled in production (`canSubmit: false`). These
acceptance fixtures run the production Web `FirstSend`, HTTP transport and
IndexedDB, or the actual native Kotlin engine in separate JVM processes, against
isolated real Gateway, Node and Agent executables. The model
provider and sandbox launcher are the existing conformance fakes: this does not
prove model-provider behavior, production sandbox isolation, authentication
infrastructure, the full Web UI, or Android OS/device behavior.

## Web client

Install the repository's JavaScript dependencies and its dedicated test browser
(`node apps/android/tool/parity/install_test_browser.mjs`). Do not pass an everyday
Chrome executable or profile. The helper validates the executable and creates its
own temporary profile. Build the two Rust executables into a run-owned target
directory, then run:

```sh
first_send_run="$(mktemp -d "${TMPDIR:-/tmp}/pirc-first-send.XXXXXX")"
export CARGO_TARGET_DIR="$first_send_run/target"
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
cargo build --locked -p pirc-gateway -p pirc-node
PIRC_CONFORMANCE_BIN_DIR="$CARGO_TARGET_DIR/debug" \
  cargo test --locked -p pirc-conformance --test conversation_web_client \
  -- --ignored --nocapture
```

Set `PIRC_TEST_NODE` if `node` is not on PATH. `PIRC_TEST_BROWSER` may point to a
validated dedicated Headless Shell executable. This is an explicit acceptance
test, ignored by the default workspace/conformance suite; a normal green CI run
does not mean it ran. It fails if binaries, browser or dependencies are missing.
Use a fresh run-owned `CARGO_TARGET_DIR`; preserve shared caches, SDKs and APKs.

The fixture binds only loopback and uses its own synthetic owner and provider.
Its trusted-proxy adapter adds the fixture identity and changes only the returned
`canSubmit` capability to exercise the pending client flow. It asserts that the
actual Gateway still returns false; production configuration is never changed.
All prepare, upload, accept, materialize, control, dispatch and receipt operations
are real HTTP calls to the built Gateway.

Three cases must converge on the original conversation, attachment and command:

- Dispatch succeeds, then the connection drops before response headers. Chromium
  may transparently replay the POST; all requests must resolve to the same command.
- Dispatch succeeds at the server, then its HTTP response body is truncated.
- Dispatch succeeds and returns, then the real IndexedDB receipt transaction
  aborts; further writes fail until the browser is restarted.

Web and native clients now persist uncertainty before remote effects; if both
receipt and error writes fail, the last committed record is still honest. The
native process fixture below tests its live backend path separately; this browser
fixture does not exercise a native device. Before restart, interrupted cases retain
frozen, uncertain original input. A transport-replayed response may already be admitted. The browser
is closed, both Gateway and Node are crashed/restarted, and two new pages query
their persisted drafts. They must agree with the server. Even a later explicit
continue of an admitted operation must make GET requests only: no additional
dispatch, one user history entry and one model request per operation, unchanged
session/command IDs and exact attachment bytes. The fixture checks both the native Node upload
files and browser Blobs, before and after restart.

## Paired native client in separate JVM processes

Use an ordinary macOS/Linux user (not root), Java 17+, the existing Android SDK
platform 36 and the repository's resolved Gradle dependencies. The compiler helper
reads pinned Kotlin/runtime jars from the existing Gradle cache, does not download
tools and does not build Flutter or an APK. Reuse the run-owned Rust target built
above, or create one and build Gateway/Node with the same profile variables.
A dedicated browser is not required for this native test.

```sh
python3 scripts/prepare-native-first-send.py --out "$first_send_run/native"
PIRC_NATIVE_FIRST_SEND_RUNTIME="$first_send_run/native/runtime.json" \
  PIRC_CONFORMANCE_BIN_DIR="$CARGO_TARGET_DIR/debug" \
  cargo test --locked -p pirc-conformance --test conversation_native_client \
  -- --ignored --nocapture
```

Use `--java /absolute/path/to/java` and `--sdk /absolute/path/to/android-sdk` when
needed. The output directory must be new. The helper compiles the actual native
engine, file journal, HTTP client and unchanged extracted bridge conversion
helpers with warnings treated as errors. This fixture is ignored by the default
suite and must be run explicitly; it fails on missing prerequisites.

The harness creates two paired device tokens through the real Gateway API. Both
native clients send their own bearer tokens without a browser identity or Origin.
The test-only interceptor supplies the fixture Host routing and enables the
returned capability while asserting production still reports `canSubmit: false`.
Gateway/Node APIs, pairing authorization and revocation remain real. Synthetic
credentials live only in the fixture's private config file and are removed on exit.

Before dispatch, the second client opens each pending conversation through the
native adoption API. It has its own private journal and no copy of the first
client's attachment files. Two operations then inject faults after real dispatch:

- Discard the successful HTTP reply before returning it to the native engine.
- Make the actual operation directory read-only before the receipt write; both
  the atomic receipt write and subsequent error write fail. The previous journal
  remains readable and frozen/uncertain, with the original file bytes intact.

The first JVM exits completely. Gateway and Node are crashed/restarted, then a
fresh JVM opens both clients' journals. The first client's Continue and the second
client's Check only query results. Both recover the same session and admitted
command; exactly one user entry and model request exist per original, and native
upload/private attachment bytes are unchanged. Already admitted operations are
intentionally absent from the pending-session adoption API.

Finally, the harness revokes the first device. Its admitted-result lookup and new
submission both receive 401; the new input remains editable and unchanged, and no
remote preparation exists for it. The second device can still check both admitted
results. Every recovery/revocation-phase native request is GET-only.

This is native Kotlin/JVM process and real backend evidence, **not Android OS,
Keystore, MethodChannel, emulator or physical-device acceptance**. The model and
sandbox launcher remain conformance fakes. It does not close simultaneous device
mutation, Stop/delete, interrupted allocation or mixed-version gates.

## Cleanup and remaining gates

The browser helper closes its own profile/server, and the conformance fixture
stops its processes and removes its private state. After the test process exits,
remove only the run-owned target/log directory you created. Keep this proof
separate from the remaining permission/device-race, Stop/delete, actual-device,
migration/rollback and activation gates recorded in
[the architecture plan](../../plans/unified-conversations.md).
