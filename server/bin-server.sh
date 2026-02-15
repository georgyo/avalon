#!/usr/bin/env sh
# Wrapper script for avalon-server
# This allows the bin entry to work by using tsx to run the TypeScript source

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

if [ ! -f "server.ts" ]; then
  echo "Error: server.ts not found in $SCRIPT_DIR" >&2
  exit 1
fi

# Prefer local tsx installation over npx download
if [ -f "../node_modules/.bin/tsx" ]; then
  exec ../node_modules/.bin/tsx server.ts "$@"
else
  exec npx tsx server.ts "$@"
fi
