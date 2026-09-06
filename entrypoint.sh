#!/bin/sh
if [ "$1" = "--auth" ]; then
  # Run auth command
  shift
  exec bun --use-system-ca run dist/main.js auth "$@"
else
  # Default command
  export HOST="${HOST:-0.0.0.0}"
  exec bun --use-system-ca run dist/main.js start -g "$GH_TOKEN" "$@"
fi
