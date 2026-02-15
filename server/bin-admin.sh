#!/usr/bin/env sh
# Wrapper script for avalon-admin
# This allows the bin entry to work by using tsx to run the TypeScript source

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

if [ ! -f "admin.ts" ]; then
  echo "Error: admin.ts not found in $SCRIPT_DIR" >&2
  exit 1
fi

exec npx tsx admin.ts "$@"
