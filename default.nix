{
  lib,
  stdenv,
  nodejs-slim_24,
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
    hash = "sha256-HUtkO5Q4mFpHrPe1kcAdehiz0eKDogMybr5Z0u+SuTQ=";
  };

  nativeBuildInputs = [
    nodejs
    yarn-berry_4
    yarn-berry_4.yarnBerryConfigHook
    # python3 is needed for node-gyp native module builds (e.g. re2) that run
    # during the build-step of `yarn install`.
    python3
  ];

  # Force native modules (re2, etc.) to build from source rather than fetch
  # prebuilt binaries over the (disabled) network.
  env.npm_config_build_from_source = "true";

  buildPhase = ''
    runHook preBuild

    yarn workspace @avalon/server typecheck
    yarn build
    yarn bundle:server

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Install only the bundled server and client dist.
    mkdir -p $out/lib/avalon

    # Copy the bundled server (single file).
    cp dist-server/server.js $out/lib/avalon/server.js

    # Copy the built client assets next to the server.
    cp -r server/dist $out/lib/avalon/dist

    # Create bin wrapper.
    mkdir -p $out/bin
    cat > $out/bin/avalon-server <<WRAPPER
    #!/bin/sh
    exec '${nodejs}/bin/node' '$out/lib/avalon/server.js' "\$@"
    WRAPPER
    chmod +x $out/bin/avalon-server

    runHook postInstall
  '';
})
