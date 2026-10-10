FROM nixpkgs/nix-flakes:latest AS build

COPY . /src

RUN --mount=type=cache,id=s/1d457021-351d-4d45-9d11-9cc268601d0b/root/nix,target=/nix-out \
    cd /src \
    && nix build \
    --extra-substituters /nix-out/?trusted=1 \
    --print-out-paths \
    --max-jobs 8 \
    "/src#"

RUN --mount=type=cache,id=s/1d457021-351d-4d45-9d11-9cc268601d0b/root/nix,target=/nix-out \
    nix copy --no-check-sigs  --all --to /nix-out

RUN mkdir -p /tmp/nix-run/store \
    && cp -R $(nix-store -qR /src/result/) /tmp/nix-run/store \
    && mv /src/result /tmp/nix-run/app

FROM scratch

COPY --from=build --link /tmp/nix-run /nix

# The installed package (server.js + the SPA in dist/). Read-only Nix store:
# nothing is written here.
WORKDIR /nix/app/lib/avalon

# The relay's radisk store lives on a persistent, writable volume. The boot
# self-test needs a scratch directory too (a scratch image has no /tmp).
# Run exactly one instance per volume (docs/p2p-protocol.md §8).
ENV GUN_DIR=/data/radata \
    TMPDIR=/data/tmp \
    PORT=8001
VOLUME /data
EXPOSE 8001

CMD ["/nix/app/bin/avalon-server"]
