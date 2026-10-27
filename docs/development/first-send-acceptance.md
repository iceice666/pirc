# First-send live client acceptance

The first-send flow remains disabled in production (`canSubmit: false`). This
acceptance fixture runs the production Web `FirstSend`, HTTP transport and
IndexedDB against isolated real Gateway, Node and Agent executables. The model
provider and sandbox launcher are the existing conformance fakes: this does not
prove model-provider behavior, production sandbox isolation, authentication
infrastructure, the full Web UI, or Android OS/device behavior.

Install the repository's JavaScript dependencies and its dedicated test browser
(`node apps/android/tool/parity/install_test_browser.mjs`). Do not pass an everyday
Chrome executable or profile. The helper validates the executable and creates its
own temporary profile. Build the two Rust executables into a run-owned target
directory, then run:

```sh
first_send_run="$(mktemp -d "${TMPDIR:-/tmp}/pirc-first-send.XXXXXX")"
export CARGO_TARGET_DIR="$first_send_run/target"
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo build --locked -p pirc-gateway -p pirc-node
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
native side has separate JVM journal/HTTP proofs; this browser fixture does not
exercise a native device. Before restart, interrupted cases retain frozen,
uncertain original input. A transport-replayed response may already be admitted. The browser
is closed, both Gateway and Node are crashed/restarted, and two new pages query
their persisted drafts. They must agree with the server. Even a later explicit
continue of an admitted operation must make GET requests only: no additional
dispatch, one user history entry and one model request per operation, unchanged
session/command IDs and exact attachment bytes. The fixture checks both the native Node upload
files and browser Blobs, before and after restart.

The browser helper closes its own profile/server, and the conformance fixture
stops its processes and removes its private state. After the test process exits,
remove only the run-owned target/log directory you created. Keep this proof
separate from the remaining permission, Stop/delete, native client, actual-device,
migration/rollback and activation gates recorded in
[the architecture plan](../../plans/unified-conversations.md).
