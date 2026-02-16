# This is a minimal `default.nix` by yarn-plugin-nixify. You can customize it
# as needed, it will not be overwritten by the plugin.

{
  pkgs ? import <nixpkgs> { },
  lib ? pkgs.lib,
}:

let

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

  project =
    pkgs.callPackage ./yarn-project.nix
      {
        nodejs = pkgs.nodejs-slim_20;
      }
      {
        src =
          with builtins;
          path {
            name = "source";
            path = ./.;
            filter =
              path: type:
              let
                bname = baseNameOf path;
              in
              !(lib.any (excluded_file: bname == excluded_file) filesToExclude);
          };
      };
in
project.overrideAttrs (oldAttrs: {

  name = "avalon-server";

  # python3 needed for node-gyp native module builds (e.g., re2) during yarn install
  nativeBuildInputs = (oldAttrs.nativeBuildInputs or [ ]) ++ [ pkgs.python3 ];

  buildPhase = ''
    yarn build
    yarn bundle:server
  '';

  installPhase = ''
    # Install only the bundled server and client dist
    mkdir -p $out/lib/avalon

    # Copy the bundled server (single file)
    cp dist-server/server.js $out/lib/avalon/server.js

    # Copy the built client assets next to the server
    cp -r server/dist $out/lib/avalon/dist

    # Create bin wrapper
    mkdir -p $out/bin
    cat > $out/bin/avalon-server <<WRAPPER
    #!/bin/sh
    exec '${pkgs.nodejs-slim_20}/bin/node' '$out/lib/avalon/server.js' "\$@"
    WRAPPER
    chmod +x $out/bin/avalon-server
  '';

})
