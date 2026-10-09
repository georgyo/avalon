{
  lib,
  stdenv,
  nodejs-slim_24,
  nodejs_24,
  yarn-berry_4,
  python3,
}:

let
  nodejs = nodejs-slim_24;

  filesToExclude = [
    "default.nix"
    "flake.nix"
    "flake.lock"
    ".beads"
    ".claude"
    ".gitignore"
    ".dolt"
    ".doltcfg"
    ".github"
    "Dockerfile"
    "result"
    "dist-server"
    "radata"
  ];
in
stdenv.mkDerivation (finalAttrs: {
  name = "avalon-server";

  src = builtins.path {
    name = "source";
    path = ./.;
    filter =
      path: _type:
      let
        bname = baseNameOf path;
      in
      !(lib.any (excluded: bname == excluded) filesToExclude);
  };

  # Hashes for packages whose yarn.lock entries carry no checksum (the
  # platform-specific optional native binaries: esbuild, @parcel/watcher,
  # @rolldown, lightningcss, ...). Yarn Berry intentionally omits checksums for
  # packages with `conditions:`, so they cannot be recorded in yarn.lock.
  # The config hook diffs this against the copy inside the offlineCache, so it
  # must be set both here and on fetchYarnBerryDeps below.
  #
  # After changing dependencies, regenerate this file and the offlineCache hash
  # below in one step:  nix run .#update-deps
  missingHashes = ./missing-hashes.json;

  # Offline Yarn Berry (v4) dependency cache, fetched by the nixpkgs
  # `yarn-berry-fetcher` directly from yarn.lock (replaces yarn-plugin-nixify).
  offlineCache = yarn-berry_4.fetchYarnBerryDeps {
    inherit (finalAttrs) src;
    missingHashes = ./missing-hashes.json;
    hash = "sha256-D5dQrkuqsTd3fCbz+tumGAtkd8PCiKlArDQfRcm+rIQ=";
  };

  nativeBuildInputs = [
    # The full nodejs (with npm) at build time: Yarn packs the git dependency `gun` (an npm project,
    # it has a package-lock.json) with `npm pack` from the offline cache's checkout. The installed
    # relay runs on nodejs-slim.
    nodejs_24
    yarn-berry_4
    yarn-berry_4.yarnBerryConfigHook
    # python3 is needed for node-gyp native module builds that may run during
    # the build step of `yarn install`.
    python3
  ];

  # Force native modules to build from source rather than fetch prebuilt
  # binaries over the (disabled) network.
  env.npm_config_build_from_source = "true";

  buildPhase = ''
    runHook preBuild

    # ESLint and the type checks of every workspace (the client's with vue-tsc, .vue files included);
    # flake.nix's checks.lint runs the same for `nix flake check`.
    yarn lint
    yarn typecheck
    yarn build
    # Single-file ESM bundle of the relay (server.ts + gun + gun/sea + express),
    # with gun-shim.ts so that SEA works inside the bundle (docs/p2p-protocol.md §8).
    yarn bundle:server

    runHook postBuild
  '';

  # The bundled relay must pass its boot self-test (SEA + input filter) outside
  # node_modules, exactly as installed. Loopback networking only.
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck

    export TMPDIR="$(mktemp -d)"
    GUN_DIR="$TMPDIR/radata" PORT=0 HOST=127.0.0.1 \
      '${nodejs}/bin/node' "$out/lib/avalon/server.js" > "$TMPDIR/relay.log" 2>&1 &
    relay=$!
    for _ in $(seq 1 60); do
      if grep -q 'listening on port' "$TMPDIR/relay.log"; then break; fi
      if ! kill -0 "$relay" 2>/dev/null; then break; fi
      sleep 0.5
    done
    cat "$TMPDIR/relay.log"
    grep -q 'Relay self-test passed' "$TMPDIR/relay.log"
    grep -q 'listening on port' "$TMPDIR/relay.log"
    kill "$relay"
    wait "$relay" || true

    runHook postInstallCheck
  '';

  installPhase = ''
    runHook preInstall

    # Install only the bundled relay and the client dist.
    mkdir -p $out/lib/avalon

    # The bundled relay (single file, includes gun, gun/sea and the shim).
    cp dist-server/server.js $out/lib/avalon/server.js

    # The built SPA next to it (server.js serves ./dist relative to itself).
    cp -r server/dist $out/lib/avalon/dist

    # bin wrapper. The radisk directory defaults to ./radata relative to the
    # working directory, which must be writable: set GUN_DIR to a persistent
    # volume (the container uses /data/radata).
    mkdir -p $out/bin
    cat > $out/bin/avalon-server <<WRAPPER
    #!/bin/sh
    exec '${nodejs}/bin/node' '$out/lib/avalon/server.js' "\$@"
    WRAPPER
    chmod +x $out/bin/avalon-server

    runHook postInstall
  '';
})
