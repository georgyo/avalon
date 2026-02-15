#!/bin/sh
# Wrapper script for avalon-server
# This allows the bin entry to work by using tsx to run the TypeScript source

cd "$(dirname "$0")"
exec npx tsx server.ts "$@"
