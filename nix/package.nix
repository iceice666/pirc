{
  lib,
  buildNpmPackage,
  importNpmLock,
  makeWrapper,
  nodejs_22,
}:

(buildNpmPackage.override { nodejs = nodejs_22; }) {
  pname = "pirc";
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
      ];
  };

  npmDeps = importNpmLock { npmRoot = ../.; };
  npmConfigHook = importNpmLock.npmConfigHook;
  npmBuildScript = "build";
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    npm prune --omit=dev
    rm -rf node_modules/@pirc

    mkdir -p $out/lib/pirc $out/share/pirc/web $out/bin
    cp -r apps/gateway/dist apps/gateway/package.json $out/lib/pirc/
    cp -r apps/web/dist/. $out/share/pirc/web/
    cp package.json package-lock.json $out/lib/pirc/
    cp -r node_modules $out/lib/pirc/

    makeWrapper ${nodejs_22}/bin/node $out/bin/pirc-gateway \
      --add-flags "$out/lib/pirc/dist/src/index.js"

    runHook postInstall
  '';

  meta = {
    description = "Private forward-authenticated web client for persistent Pi RPC sessions";
    mainProgram = "pirc-gateway";
    platforms = lib.platforms.unix;
  };
}
