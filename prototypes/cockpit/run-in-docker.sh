#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

docker run --rm \
  -v "$root:/workspace" \
  -w /workspace/prototypes/cockpit \
  oven/bun:1.3.14-alpine \
  sh -lc 'apk add --no-cache tmux >/dev/null && bun run.ts'
