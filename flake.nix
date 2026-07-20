{
  description = "Avalon game server Flake";

  inputs = {

    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/x86_64-linux";
    flake-utils = {
      url = "github:numtide/flake-utils";
      inputs.systems.follows = "systems";
    };

  };

  nixConfig = {
    extra-substituters = [ "https://cache.fu.io" ];
    extra-trusted-public-keys = [
      "georgyo-1:2yY6X+H3y0xp9e94WQsjXlWNDX2ElWWrp5P89pQ9zPM="
    ];
  };


  outputs = { self, nixpkgs, flake-utils, ... }@inputs:
    let
      overlay = final: prev: {
        avalon-online = final.callPackage ./default.nix { };
      };
      rev = if (self ? shortRev) then self.shortRev else self.dirtyShortRev;
    in
    flake-utils.lib.eachDefaultSystem
      (system:
        let
          pkgs = import nixpkgs { inherit system; overlays = [ overlay ]; };

          # `nix run .#update-deps` — run from the repo root after changing
          # dependencies (yarn.lock). Regenerates missing-hashes.json and
          # rewrites the fetchYarnBerryDeps hash in default.nix in place.
          update-deps = pkgs.writeShellApplication {
            name = "update-deps";
            runtimeInputs = [ pkgs.yarn-berry_4.yarn-berry-fetcher ];
            text = ''
              if [ ! -f yarn.lock ] || [ ! -f default.nix ]; then
                echo "error: run this from the repository root (need yarn.lock and default.nix)" >&2
                exit 1
              fi

              echo "==> Regenerating missing-hashes.json from yarn.lock" >&2
              yarn-berry-fetcher missing-hashes yarn.lock > missing-hashes.json

              echo "==> Computing offlineCache hash (downloads all deps, may take a minute)" >&2
              newHash="$(yarn-berry-fetcher prefetch yarn.lock missing-hashes.json)"

              echo "==> Rewriting fetchYarnBerryDeps hash in default.nix" >&2
              sed -i -E "s#(hash = \")sha256-[A-Za-z0-9+/=]+(\";)#\1''${newHash}\2#" default.nix

              echo >&2
              echo "Done:" >&2
              echo "  missing-hashes.json : regenerated" >&2
              echo "  offlineCache hash   : ''${newHash}" >&2
            '';
          };
        in
        {
          packages = rec {
            default = pkgs.avalon-online;
            container = pkgs.dockerTools.buildLayeredImage {
              name = "avalon";
              tag = "${rev}";
              config = {
                Cmd = [ "${pkgs.avalon-online}/bin/avalon-server" ];
                ExposePorts = { "8001/tcp" = { }; };

              };
            };
          };

          apps.update-deps = {
            type = "app";
            program = "${update-deps}/bin/update-deps";
            meta.description = "Regenerate missing-hashes.json and the offlineCache hash in default.nix after dependency changes";
          };
        }
      )
    // {
      overlays.default = overlay;
    }
  ;
}
