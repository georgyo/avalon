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

WORKDIR /nix/app/libexec/avalon/server
CMD ["/nix/app/bin/avalon-server"]
