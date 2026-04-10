#!/usr/bin/env bash
set -euo pipefail

ADAPTER_DIR="${ADAPTER_DIR:?ADAPTER_DIR is required}"
ADAPTER_DIR="$(cd "${ADAPTER_DIR}" && pwd)"
ADAPTER_ENTRY_PATH="${NEXT_ADAPTER_PATH:-${ADAPTER_DIR}/adapter/index.cjs}"
WRANGLER_VERSION="${WRANGLER_VERSION:-$(node -p "require('${ADAPTER_DIR}/package.json').devDependencies.wrangler")}"
BUILD_LOG=".adapter-build.log"
SERVER_LOG=".adapter-server.log"
PID_FILE=".adapter-server.pid"
PORT_FILE=".adapter-server.port"
NODE_SIDECAR_LOG=".adapter-node-sidecar.log"
NODE_SIDECAR_PID_FILE=".adapter-node-sidecar.pid"
NODE_SIDECAR_PORT_FILE=".adapter-node-sidecar.port"
INSPECTOR_PORT_FILE=".adapter-inspector.port"
WRANGLER_CONFIG="wrangler.jsonc"
DEPLOYMENT_URL=""
DEPLOYMENT_READY=0

cleanup_on_error() {
  if [ "${DEPLOYMENT_READY}" = "1" ]; then
    return
  fi

  if [ -f "${BUILD_LOG}" ] || [ -f "${SERVER_LOG}" ]; then
    {
      echo
      echo "=== adapter deploy debug ==="

      if [ -f "${BUILD_LOG}" ]; then
        echo "--- ${BUILD_LOG} ---"
        tail -n 200 "${BUILD_LOG}" || true
      fi

      if [ -f "${SERVER_LOG}" ]; then
        echo "--- ${SERVER_LOG} ---"
        tail -n 200 "${SERVER_LOG}" || true
      fi

      if [ -f "${NODE_SIDECAR_LOG}" ]; then
        echo "--- ${NODE_SIDECAR_LOG} ---"
        tail -n 200 "${NODE_SIDECAR_LOG}" || true
      fi

      echo "=== end adapter deploy debug ==="
      echo
    } >&2
  fi

  if [ -f "${NODE_SIDECAR_PID_FILE}" ]; then
    local sidecar_pid
    sidecar_pid="$(cat "${NODE_SIDECAR_PID_FILE}")"

    kill -TERM "${sidecar_pid}" >/dev/null 2>&1 || true
    sleep 1
    kill -KILL "${sidecar_pid}" >/dev/null 2>&1 || true
  fi

  if [ -f "${PID_FILE}" ]; then
    local pid
    pid="$(cat "${PID_FILE}")"

    pkill -TERM -P "${pid}" >/dev/null 2>&1 || true
    kill -TERM "${pid}" >/dev/null 2>&1 || true
    sleep 1
    pkill -KILL -P "${pid}" >/dev/null 2>&1 || true
    kill -KILL "${pid}" >/dev/null 2>&1 || true
  fi
}

find_free_port() {
  node <<'EOF'
const net = require('node:net')

const server = net.createServer()
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address !== 'object') {
    console.error('Failed to allocate a free port')
    process.exit(1)
  }

  console.log(address.port)
  server.close()
})
EOF
}

run_next_build() {
  if [ -x "node_modules/.bin/next" ]; then
    "./node_modules/.bin/next" build --experimental-next-config-strip-types
    return
  fi

  npx next build --experimental-next-config-strip-types
}

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
    return
  fi

  corepack pnpm "$@"
}

ensure_wrangler_dependency() {
  WRANGLER_VERSION="${WRANGLER_VERSION}" node <<'EOF'
const fs = require('node:fs')

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
pkg.devDependencies ??= {}
pkg.devDependencies.wrangler = process.env.WRANGLER_VERSION
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
EOF
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-120}"
  local delay_seconds="${3:-0.5}"
  local attempt

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl -sS -o /dev/null --max-time 2 "${url}"; then
      return 0
    fi

    if [ -f "${PID_FILE}" ]; then
      local pid
      pid="$(cat "${PID_FILE}")"

      if ! kill -0 "${pid}" >/dev/null 2>&1; then
        return 1
      fi
    fi

    sleep "${delay_seconds}"
  done

  return 1
}

trap cleanup_on_error EXIT

if [ ! -f "${ADAPTER_ENTRY_PATH}" ]; then
  echo "Could not find adapter entry at ${ADAPTER_ENTRY_PATH}" >&2
  exit 1
fi

rm -f \
  "${BUILD_LOG}" \
  "${SERVER_LOG}" \
  "${PID_FILE}" \
  "${PORT_FILE}" \
  "${NODE_SIDECAR_LOG}" \
  "${NODE_SIDECAR_PID_FILE}" \
  "${NODE_SIDECAR_PORT_FILE}" \
  "${INSPECTOR_PORT_FILE}"
rm -rf ".next" ".adapter" ".wrangler"

PORT="$(find_free_port)"
NODE_SIDECAR_PORT="$(find_free_port)"
INSPECTOR_PORT="$(find_free_port)"
DEPLOYMENT_URL="http://127.0.0.1:${PORT}"

cat > "${WRANGLER_CONFIG}" <<'EOF'
{
  "name": "next-cloudflare-adapter-e2e-local",
  "main": ".adapter/worker.mjs",
  "compatibility_date": "2026-03-26",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": ".adapter/assets",
    "binding": "ASSETS",
    "run_worker_first": true
  }
}
EOF

{
  echo "Adapter entry: ${ADAPTER_ENTRY_PATH}"
  echo "Wrangler version: ${WRANGLER_VERSION}"
  echo "Deploy URL: ${DEPLOYMENT_URL}"
  echo "Node sidecar URL: http://127.0.0.1:${NODE_SIDECAR_PORT}"
  echo "Wrangler inspector URL: ws://127.0.0.1:${INSPECTOR_PORT}"
  echo "Next test dir: ${NEXT_TEST_DIR:-unknown}"
} > "${BUILD_LOG}"

export CI=1
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export NEXT_ADAPTER_PATH="${ADAPTER_ENTRY_PATH}"
export NEXT_PRIVATE_TEST_MODE="${NEXT_PRIVATE_TEST_MODE:-e2e}"
export __NEXT_TEST_MODE="${__NEXT_TEST_MODE:-${NEXT_PRIVATE_TEST_MODE}}"

ensure_wrangler_dependency >> "${BUILD_LOG}" 2>&1
run_pnpm install --strict-peer-dependencies=false --no-frozen-lockfile >> "${BUILD_LOG}" 2>&1
run_next_build >> "${BUILD_LOG}" 2>&1

BUILD_ID="$(cat ".next/BUILD_ID")"
DEPLOYMENT_ID="next-cloudflare-adapter-local-${PORT}"
IMMUTABLE_ASSET_TOKEN="undefined"

cat > ".adapter/generated/local-dev-config.mjs" <<EOF
export const nodeSidecarPort = ${NODE_SIDECAR_PORT}
EOF

{
  echo "BUILD_ID: ${BUILD_ID}"
  echo "DEPLOYMENT_ID: ${DEPLOYMENT_ID}"
  echo "IMMUTABLE_ASSET_TOKEN: ${IMMUTABLE_ASSET_TOKEN}"
} >> "${BUILD_LOG}"

echo "${PORT}" > "${PORT_FILE}"
echo "${NODE_SIDECAR_PORT}" > "${NODE_SIDECAR_PORT_FILE}"
echo "${INSPECTOR_PORT}" > "${INSPECTOR_PORT_FILE}"

node "${ADAPTER_DIR}/scripts/adapter-node-sidecar.mjs" \
  --project-dir "${PWD}" \
  --port "${NODE_SIDECAR_PORT}" \
  >> "${NODE_SIDECAR_LOG}" 2>&1 &

NODE_SIDECAR_PID="$!"
echo "${NODE_SIDECAR_PID}" > "${NODE_SIDECAR_PID_FILE}"

if ! wait_for_http "http://127.0.0.1:${NODE_SIDECAR_PORT}/_adapter/status"; then
  echo "Node sidecar did not become ready at http://127.0.0.1:${NODE_SIDECAR_PORT}" >&2
  exit 1
fi

export CLOUDFLARE_ADAPTER_NODE_SIDECAR_PORT="${NODE_SIDECAR_PORT}"
run_pnpm exec wrangler dev \
  --config "${WRANGLER_CONFIG}" \
  --ip 127.0.0.1 \
  --port "${PORT}" \
  --inspector-port "${INSPECTOR_PORT}" \
  >> "${SERVER_LOG}" 2>&1 &

WRANGLER_PID="$!"
echo "${WRANGLER_PID}" > "${PID_FILE}"

if ! wait_for_http "${DEPLOYMENT_URL}"; then
  echo "Wrangler did not become ready at ${DEPLOYMENT_URL}" >&2
  exit 1
fi

DEPLOYMENT_READY=1
printf '%s\n' "${DEPLOYMENT_URL}"
