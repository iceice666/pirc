{
  lib,
  stdenvNoCC,
  bun,
  nodeModulesHash ? "sha256-0QtIq5Xc+6qI0p8+eWRJXrvOYJjwjxktLBNtTEGM38Y=",
}:

let
  version = "0.1.0";

  src = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: type:
      let
        name = baseNameOf path;
      in
      !lib.elem name [
        ".git"
        "node_modules"
        "dist"
        ".state"
        "result"
        "plans"
      ];
  };

  # Dependencies for every os/cpu, so one hash covers all systems.
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
  pname = "pirc";
  inherit version src;
  nativeBuildInputs = [ bun ];

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
    bun run build
    runHook postBuild
  '';

  # A bun --compile binary carries its payload at the end of the file.
  dontStrip = true;
  dontPatchELF = true;

  installPhase = ''
    runHook preInstall
    install -Dm755 apps/gateway/dist/pirc $out/bin/pirc
    mkdir -p $out/share/pirc/web
    cp -r apps/web/dist/. $out/share/pirc/web/
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    $out/bin/pirc version
  '';

  passthru = { inherit nodeModules; };

  meta = {
    description = "Private forward-authenticated web client with a built-in coding agent";
    mainProgram = "pirc";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  };
}
