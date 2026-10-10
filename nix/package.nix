{
  lib,
  stdenvNoCC,
  bun,
  makeBinaryWrapper,
  callPackage,
  role ? "gateway",
  # The OS sandbox nodes wrap agents in (docs/history/sandbox.md).
  # Not named `srt`: callPackage would inject nixpkgs' unrelated `srt`
  # (a video streaming library) instead of this default.
  sandboxRuntime ? callPackage ./sandbox-runtime.nix { },
  nodeModulesHash ? "sha256-6ewZSbFTpl1szNtRtIp5epzSDKYXOY7Z5lU6I9JBFvY=",
}:

assert lib.elem role [
  "gateway"
  "chat"
  "node"
];

let
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  executable = "pirc-${role}";
  runsAgents = role != "gateway";

  src = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: type:
      let
        name = baseNameOf path;
      in
      # The Android client builds with Gradle, not into these binaries.
      toString path != toString ../apps/android
      && !lib.elem name [
        ".git"
        "node_modules"
        "dist"
        ".state"
        "result"
        "plans"
        # The Rust rewrite (plans/rust-rewrite.md) is not part of these packages yet.
        "crates"
        "target"
        "Cargo.toml"
        "Cargo.lock"
      ];
  };

  # Shared build dependencies, not a combined executable: every role compiles
  # its own entry point below. One fixed-output hash covers every os/cpu.
  nodeModules = stdenvNoCC.mkDerivation {
    pname = "pirc-node-modules";
    inherit version src;
    nativeBuildInputs = [ bun ];
    dontConfigure = true;
    dontFixup = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      bun install --frozen-lockfile --ignore-scripts --no-progress --os='*' --cpu='*'
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -a node_modules $out/
      for dir in apps/*/node_modules; do
        mkdir -p $out/$(dirname $dir)
        cp -a $dir $out/$dir
      done
      runHook postInstall
    '';
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = nodeModulesHash;
  };
in
stdenvNoCC.mkDerivation {
  pname = executable;
  inherit version src;
  nativeBuildInputs = [ bun ] ++ lib.optional runsAgents makeBinaryWrapper;

  configurePhase = ''
    runHook preConfigure
    export HOME=$TMPDIR
    cp -a ${nodeModules}/. .
    chmod -R u+w .
    # No Node.js in the sandbox: let Bun stand in for `node`, then rewrite
    # `#!/usr/bin/env node` (Linux sandboxes have no /usr/bin/env).
    mkdir -p $TMPDIR/bin
    ln -s ${lib.getExe bun} $TMPDIR/bin/node
    export PATH=$TMPDIR/bin:$PATH
    patchShebangs node_modules apps/*/node_modules
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    export PATH=$TMPDIR/bin:$PATH
    ${lib.optionalString (!runsAgents) "bun run --filter @pirc/web build"}
    cd apps/gateway
    bun build --compile --minify --sourcemap --external chromium-bidi \
      src/entry/${role}.ts --outfile dist/${executable}
    cd ../..
    runHook postBuild
  '';

  # A bun --compile binary carries its payload at the end of the file.
  dontStrip = true;
  dontPatchELF = true;

  installPhase = ''
    runHook preInstall
  ''
  + (
    if runsAgents then
      ''
        install -Dm755 apps/gateway/dist/${executable} $out/libexec/pirc/${executable}
        # playwright-core reads its own files (package.json, browsers.json,
        # wasm) by computed paths, which bun --compile cannot bundle.
        playwright=$(echo node_modules/.bun/playwright-core@*/node_modules/playwright-core)
        [ -f "$playwright/index.js" ]
        mkdir -p $out/lib/pirc
        cp -rL "$playwright" $out/lib/pirc/playwright-core
        makeBinaryWrapper $out/libexec/pirc/${executable} $out/bin/${executable} \
          --set-default PIRC_PLAYWRIGHT_CORE $out/lib/pirc/playwright-core \
          --set-default PIRC_SANDBOX_SRT ${lib.getExe sandboxRuntime}
      ''
    else
      ''
        install -Dm755 apps/gateway/dist/${executable} $out/bin/${executable}
        mkdir -p $out/share/pirc/web
        cp -r apps/web/dist/. $out/share/pirc/web/
      ''
  )
  + ''
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    $out/bin/${executable} version
  '';

  passthru = {
    inherit nodeModules role;
  }
  // lib.optionalAttrs runsAgents { inherit sandboxRuntime; };

  meta = {
    description =
      {
        gateway = "Private forward-authenticated gateway and web UI";
        chat = "Managed chat workspace host with a built-in coding agent";
        node = "Coding workspace host with a built-in coding agent";
      }
      .${role};
    mainProgram = executable;
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  };
}
