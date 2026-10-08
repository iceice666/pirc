# Anthropic's sandbox runtime (`srt`), which pirc nodes wrap agents in
# (docs/history/sandbox.md). Pinned here rather than taken from nixpkgs, which
# trails the upstream release pace by months.
{
  lib,
  stdenv,
  buildNpmPackage,
  fetchFromGitHub,
  fetchurl,
  nodejs,
  ripgrep,
  which,
  # Linux only
  bubblewrap,
  socat,
}:

let
  version = "0.0.78";

  # The static seccomp helpers (Linux x64/arm64) are built by upstream's
  # release workflow and shipped only in the npm tarball, not in git.
  npmTarball = fetchurl {
    url = "https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-${version}.tgz";
    hash = "sha256-qc+eNQaKTHHS2U3osKvo3lHH1E2u9TfMkpBoSMzGckA=";
  };
in
buildNpmPackage {
  pname = "sandbox-runtime";
  inherit version nodejs;

  src = fetchFromGitHub {
    owner = "anthropic-experimental";
    repo = "sandbox-runtime";
    tag = "v${version}";
    hash = "sha256-ChqWdx8unuXjlg+F7yeBNYK79y7Mf+0aNr/Y5htPBoQ=";
  };

  npmDepsHash = "sha256-l9eGVqggdBbTQt9kWmJMgMZLUZOYfXY65ZjShslTn9k=";

  strictDeps = true;

  postInstall = lib.optionalString stdenv.hostPlatform.isLinux ''
    package=$out/lib/node_modules/@anthropic-ai/sandbox-runtime
    mkdir -p $TMPDIR/npm
    tar -xzf ${npmTarball} -C $TMPDIR/npm
    mkdir -p $package/vendor/seccomp
    cp -r $TMPDIR/npm/package/vendor/seccomp/x64 $TMPDIR/npm/package/vendor/seccomp/arm64 $package/vendor/seccomp/
  '';

  postFixup =
    let
      runtimeDeps = [
        ripgrep
        which
      ]
      ++ lib.optionals stdenv.hostPlatform.isLinux [
        bubblewrap
        socat
      ];
    in
    ''
      wrapProgram $out/bin/srt --prefix PATH : ${lib.makeBinPath runtimeDeps}
    '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    [ "$($out/bin/srt --version)" = "${version}" ]
    runHook postInstallCheck
  '';

  meta = {
    description = "OS-level filesystem and network sandbox for arbitrary processes";
    homepage = "https://github.com/anthropic-experimental/sandbox-runtime";
    license = lib.licenses.asl20;
    mainProgram = "srt";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
