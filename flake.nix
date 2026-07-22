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
          # `nix run .#e2e` — bring up the throwaway local stack (Firebase
          # emulators + API server + vite dev) and run the Playwright e2e suite
          # against it. Unlike `nix build`, this app runs with network access, so
          # `yarn install` and the Firestore emulator JAR download work normally;
          # what Nix pins is the toolchain: Node, the JDK the Firestore emulator
          # needs, and the Playwright browsers.
          #
          # The Playwright browsers come from nixpkgs' playwright-driver (already
          # patched to find their libraries in the Nix store), so no `apt`/root
          # `--with-deps` step is needed. This requires the npm `playwright`
          # version to match playwright-driver's: keep the `playwright` pin in
          # package.json equal to `pkgs.playwright-driver.version`.
          e2e = pkgs.writeShellApplication {
            name = "avalon-e2e";
            runtimeInputs = [
              pkgs.nodejs_24
              pkgs.yarn-berry_4
              pkgs.jdk_headless
            ];
            text = ''
              driverVer='${pkgs.playwright-driver.version}'
              pinnedVer="$(node -p "require('./package.json').devDependencies.playwright" 2>/dev/null || echo '?')"
              if [ "$driverVer" != "$pinnedVer" ]; then
                echo "error: package.json pins playwright '$pinnedVer' but nixpkgs playwright-driver is '$driverVer'." >&2
                echo "       The Nix-provided browsers won't match. Align the pin, then update yarn.lock." >&2
                exit 1
              fi

              export PLAYWRIGHT_BROWSERS_PATH='${pkgs.playwright-driver.browsers}'
              export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
              export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true

              yarn install --immutable
              exec yarn test:e2e
            '';
          };

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

          apps.e2e = {
            type = "app";
            program = "${e2e}/bin/avalon-e2e";
            meta.description = "Run the Playwright e2e suite against a throwaway local stack with a Nix-pinned toolchain";
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
