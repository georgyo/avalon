# This is a minimal `default.nix` by yarn-plugin-nixify. You can customize it
# as needed, it will not be overwritten by the plugin.

{ pkgs ? import <nixpkgs> { }, lib ? pkgs.lib }:

let
  project =
    pkgs.callPackage ./yarn-project.nix
      {
        nodejs = pkgs.nodejs-slim_20;
      }
      {
        src = with builtins; path {
          name = "source";
          path = ./.;
          filter = path: type:
            let bname = baseNameOf path; in
            bname != "default.nix"
            && bname != "Dockerfile"
            && bname != "flake.nix"
            && bname != "flake.lock";
        };

      };
in
project.overrideAttrs (oldAttrs: {

  name = "avalon";

  nativeBuildInputs = (oldAttrs.nativeBuildInputs or []) ++ [
    pkgs.python3
    pkgs.pkg-config
    pkgs.nodePackages.patch-package
  ];

  buildInputs = (oldAttrs.buildInputs or []) ++ [
    pkgs.re2
  ];

  buildPhase = ''
    yarn build
    (cd server && ln -s ../client/dist .)
  '';

})
