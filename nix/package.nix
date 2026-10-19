{
  lib,
  stdenv,
  rustPlatform,
  makeWrapper,
  bubblewrap,
  callPackage,
  role ? "gateway",
}:
assert lib.elem role [
  "gateway"
  "node"
];
let
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  web = callPackage ./web.nix { };
in
rustPlatform.buildRustPackage {
  pname = "pirc-${role}";
  inherit version;
  # Explicit allowlist: neither local state/credentials nor retired TS sources
  # can enter the server build or runtime closure.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../crates
    ];
  };
  cargoHash = "sha256-GpiZltQWK224Lfl6DCXPnM2bqC1ruMhlyrwpsLVdFFk=";
  cargoBuildFlags = [
    "-p"
    "pirc-${role}"
  ];
  cargoTestFlags = [
    "-p"
    "pirc-${role}"
    "--lib"
  ];
  # The gateway is binary-only; network/process integration tests run in CI,
  # not in the Nix build sandbox. Install checks cover both shipped CLIs.
  doCheck = false;
  nativeBuildInputs = lib.optional (role == "node") makeWrapper;
  postInstall = ''
    # Include nested notices (notably rquickjs-sys/quickjs/LICENSE), not just
    # crate-root licenses. cargoDeps is the locked, unpacked vendor tree.
    licenses=$out/share/licenses/pirc-${role}
    mkdir -p "$licenses/rust"
    (
      cd "$cargoDeps"
      find -L . -type f \( -iname 'license*' -o -iname 'licence*' -o -iname 'notice*' \
        -o -iname 'copying*' -o -iname 'copyright*' \) -print0 > "$TMPDIR/pirc-notices"
      # cp --parents inherits read-only store directory modes; install -D
      # creates writable parents until the output is finalized instead.
      while IFS= read -r -d $'\0' file; do
        install -Dm644 "$file" "$licenses/rust/$file"
      done < "$TMPDIR/pirc-notices"
    )
    cp crates/pirc-node/NOTICE "$licenses/pirc-node-NOTICE"
    cp crates/pirc-node/src/browser/assets/PLAYWRIGHT-{LICENSE,NOTICE} "$licenses/"
  ''
  + lib.optionalString (role == "gateway") ''
    mkdir -p $out/share/pirc
    ln -s ${web}/share/pirc/web $out/share/pirc/web
  ''
  + lib.optionalString (role == "node" && stdenv.hostPlatform.isLinux) ''
    wrapProgram $out/bin/pirc-node --prefix PATH : ${lib.makeBinPath [ bubblewrap ]}
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    test "$($out/bin/pirc-${role} --version)" = "${version}"
    $out/bin/pirc-${role} --help
  '';
  passthru = {
    inherit role;
  }
  // lib.optionalAttrs (role == "gateway") { inherit web; };
  meta = {
    description =
      if role == "gateway" then
        "Private forward-authenticated gateway and web UI"
      else
        "Native coding and chat node with a sandboxed agent";
    mainProgram = "pirc-${role}";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
