#!/usr/bin/env bash
set -euo pipefail

PID_FILE=".adapter-server.pid"
NODE_SIDECAR_PID_FILE=".adapter-node-sidecar.pid"

if [ -f "${NODE_SIDECAR_PID_FILE}" ]; then
  NODE_SIDECAR_PID="$(cat "${NODE_SIDECAR_PID_FILE}")"
  kill -TERM "${NODE_SIDECAR_PID}" >/dev/null 2>&1 || true
  sleep 1
  kill -KILL "${NODE_SIDECAR_PID}" >/dev/null 2>&1 || true
fi

if [ ! -f "${PID_FILE}" ]; then
  rm -f "${NODE_SIDECAR_PID_FILE}" ".adapter-node-sidecar.port"
  exit 0
fi

PID="$(cat "${PID_FILE}")"

pkill -TERM -P "${PID}" >/dev/null 2>&1 || true
kill -TERM "${PID}" >/dev/null 2>&1 || true
sleep 1
pkill -KILL -P "${PID}" >/dev/null 2>&1 || true
kill -KILL "${PID}" >/dev/null 2>&1 || true

rm -f \
  "${PID_FILE}" \
  ".adapter-server.port" \
  "${NODE_SIDECAR_PID_FILE}" \
  ".adapter-node-sidecar.port"
