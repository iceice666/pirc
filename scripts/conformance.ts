/**
 * Run (or, with `--record`, re-record) the black-box conformance suite
 * (`crates/pirc-conformance`) against the release executables.
 *
 * Linux only: the snapshots are recorded on Linux, the platform CI and
 * deployments use. On macOS `/tmp` is `/private/tmp`, Seatbelt lists Unix
 * sockets and the node warns about its temporary directory, so transcripts
 * differ without the contract changing (plans/rust-rewrite.md, "Complete
 * macOS runtime validation"). Elsewhere the run is skipped and recording
 * refused, so macOS output never replaces the Linux snapshots.
 */
const record = process.argv.includes('--record');

if (process.platform !== 'linux') {
  if (record) {
    console.error(`conformance: snapshots are recorded on Linux only, not on ${process.platform}`);
    process.exit(1);
  }
  console.log(`conformance: skipped on ${process.platform} (snapshots are Linux's; CI runs them)`);
  process.exit(0);
}

const run = Bun.spawnSync(['cargo', 'test', '--locked', '-p', 'pirc-conformance'], {
  env: {
    ...process.env,
    PIRC_CONFORMANCE_REQUIRED: '1',
    PIRC_CONFORMANCE_BIN_DIR: 'target/release',
    INSTA_UPDATE: record ? 'always' : 'no',
  },
  stdio: ['inherit', 'inherit', 'inherit'],
});
process.exit(run.exitCode ?? 1);
