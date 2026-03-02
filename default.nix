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
        nodejs = pkgs.nodejs-slim_24;
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
  '';

  installPhase = ''
    # Install client static assets and schema
    mkdir -p $out/lib/avalon

    # Copy the built client assets
    cp -r server/dist $out/lib/avalon/dist

    # Copy schema and apply script for deployment
    cp server/schema.surql $out/lib/avalon/schema.surql
    cp server/apply-schema.mjs $out/lib/avalon/apply-schema.mjs
  '';

})
