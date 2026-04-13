#!/usr/bin/env bash
set -euo pipefail

should_filter_request_logs() {
  if [ ! -f ".adapter/generated/manifest.mjs" ]; then
    return 1
  fi

  node --input-type=module <<'EOF'
import { manifest } from './.adapter/generated/manifest.mjs'

process.exit(manifest?.nextConfig?.logging === false ? 0 : 1)
EOF
}

print_server_log() {
  if [ ! -f ".adapter-server.log" ]; then
    return
  fi

  echo "=== .adapter-server.log ==="

  if should_filter_request_logs; then
    grep -E -v '^\[wrangler:info\] (GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b' ".adapter-server.log" || true
    return
  fi

  cat ".adapter-server.log"
}

if [ -f ".adapter-build.log" ]; then
  cat ".adapter-build.log"
fi

print_server_log

if [ -f ".adapter-node-sidecar.log" ]; then
  echo "=== .adapter-node-sidecar.log ==="
  cat ".adapter-node-sidecar.log"
fi
