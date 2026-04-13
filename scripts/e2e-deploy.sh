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
DEBUG_ARTIFACTS_DIR="${NEXT_ADAPTER_DEBUG_ARTIFACTS_DIR:-}"

persist_debug_artifacts() {
  if [ -z "${DEBUG_ARTIFACTS_DIR}" ]; then
    return
  fi

  local debug_dir
  local timestamp
  local pwd_slug

  timestamp="$(date +%s)"
  pwd_slug="$(printf '%s' "${PWD}" | sed 's#[^A-Za-z0-9._-]#_#g')"
  debug_dir="${DEBUG_ARTIFACTS_DIR%/}/${pwd_slug}-${timestamp}"

  mkdir -p "${debug_dir}"

  for file in \
    "package.json" \
    "next.config.js" \
    "${BUILD_LOG}" \
    "${SERVER_LOG}" \
    "${NODE_SIDECAR_LOG}" \
    "${WRANGLER_CONFIG}"; do
    if [ -f "${file}" ]; then
      cp "${file}" "${debug_dir}/$(basename "${file}")"
    fi
  done
}

cleanup_on_error() {
  if [ "${DEPLOYMENT_READY}" = "1" ]; then
    return
  fi

  persist_debug_artifacts

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
  local has_build_script
  local has_native_ts_config

  has_build_script="$(node <<'EOF'
const fs = require('node:fs')

try {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  process.stdout.write(pkg.scripts?.build ? '1' : '0')
} catch (_) {
  process.stdout.write('0')
}
EOF
)"

  has_native_ts_config="$(node <<'EOF'
const fs = require('node:fs')

process.stdout.write(
  fs.existsSync('next.config.ts') || fs.existsSync('next.config.mts') ? '1' : '0'
)
EOF
)"

  if [ "${has_native_ts_config}" = "1" ] && [ -n "${__NEXT_NODE_NATIVE_TS_LOADER_ENABLED:-}" ]; then
    :
  elif [ "${has_native_ts_config}" = "1" ]; then
    export __NEXT_NODE_NATIVE_TS_LOADER_ENABLED="true"
  fi

  if [ "${has_build_script}" = "1" ]; then
    run_pnpm run build
    return
  fi

  if [ -x "node_modules/.bin/next" ]; then
    "./node_modules/.bin/next" build --experimental-next-config-strip-types
    return
  fi

  run_pnpm exec next build --experimental-next-config-strip-types
}

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
    return
  fi

  corepack pnpm "$@"
}

ensure_pnpm_shim_on_path() {
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi

  local shim_dir="${PWD}/.adapter-bin"

  mkdir -p "${shim_dir}"
  cat > "${shim_dir}/pnpm" <<'EOF'
#!/usr/bin/env bash
exec corepack pnpm "$@"
EOF
  chmod +x "${shim_dir}/pnpm"

  case ":${PATH}:" in
    *":${shim_dir}:"*) ;;
    *) export PATH="${shim_dir}:${PATH}" ;;
  esac
}

ensure_python_shim_on_path() {
  local python_path

  python_path="$(command -v python || true)"
  if [ -z "${python_path}" ]; then
    python_path="$(command -v python3 || command -v python3.14 || true)"
  fi

  if [ -z "${python_path}" ]; then
    return
  fi

  export PYTHON="${python_path}"
  export npm_config_python="${python_path}"

  if command -v python >/dev/null 2>&1; then
    return
  fi

  local shim_dir="${PWD}/.adapter-bin"

  mkdir -p "${shim_dir}"
  cat > "${shim_dir}/python" <<EOF
#!/usr/bin/env bash
exec "${python_path}" "\$@"
EOF
  chmod +x "${shim_dir}/python"

  case ":${PATH}:" in
    *":${shim_dir}:"*) ;;
    *) export PATH="${shim_dir}:${PATH}" ;;
  esac
}

sync_local_package_dirs_to_node_modules() {
  node <<'EOF'
const fs = require('node:fs')
const path = require('node:path')

const cwd = process.cwd()
const entries = fs.readdirSync(cwd, { withFileTypes: true })
const excluded = new Set([
  '.adapter',
  '.git',
  '.next',
  '.wrangler',
  'app',
  'coverage',
  'node_modules',
  'pages',
  'public',
  'src',
  'test',
  'tests',
])

const copied = []

for (const entry of entries) {
  if (!entry.isDirectory()) {
    continue
  }

  if (excluded.has(entry.name) || entry.name.startsWith('.')) {
    continue
  }

  const sourceDir = path.join(cwd, entry.name)
  const packageJsonPath = path.join(sourceDir, 'package.json')

  if (!fs.existsSync(packageJsonPath)) {
    continue
  }

  let packageName = entry.name
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    if (typeof pkg.name === 'string' && pkg.name.length > 0) {
      packageName = pkg.name
    }
  } catch {}

  const targetDir = path.join(cwd, 'node_modules', ...packageName.split('/'))
  let resolvedTargetDir = targetDir

  try {
    if (fs.lstatSync(targetDir).isSymbolicLink()) {
      resolvedTargetDir = fs.realpathSync(targetDir)
    }
  } catch {}

  fs.mkdirSync(path.dirname(resolvedTargetDir), { recursive: true })
  fs.rmSync(resolvedTargetDir, { recursive: true, force: true })
  fs.cpSync(sourceDir, resolvedTargetDir, { recursive: true })

  const copyMode =
    resolvedTargetDir === targetDir ? 'direct' : `via ${path.relative(cwd, resolvedTargetDir)}`
  copied.push(`${entry.name} -> ${packageName} (${copyMode})`)
}

if (copied.length > 0) {
  process.stdout.write(`Synced local packages: ${copied.join(', ')}\n`)
}
EOF
}

ensure_data_url_import_declarations() {
  node <<'EOF'
const fs = require('node:fs')
const path = require('node:path')

const cwd = process.cwd()
const declarationPath = path.join(cwd, 'adapter-data-url-imports.d.ts')
const excluded = new Set([
  '.adapter',
  '.git',
  '.next',
  '.wrangler',
  'coverage',
  'node_modules',
])
const tsExtensions = new Set(['.ts', '.tsx', '.cts', '.mts'])
const dataUrlImportPattern =
  /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]data:[^'"]+['"]|(?:import|export)\s*\(\s*['"]data:[^'"]+['"]\s*\)/m

let found = false

function walk(dir) {
  if (found) {
    return
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name)) {
      continue
    }

    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      walk(fullPath)
      if (found) {
        return
      }
      continue
    }

    if (!entry.isFile() || !tsExtensions.has(path.extname(entry.name))) {
      continue
    }

    try {
      const source = fs.readFileSync(fullPath, 'utf8')
      if (dataUrlImportPattern.test(source)) {
        found = true
        return
      }
    } catch {}
  }
}

walk(cwd)

if (!found) {
  process.exit(0)
}

const contents = `declare module 'data:*' {\n  const value: string\n  export default value\n}\n`

if (fs.existsSync(declarationPath)) {
  const existing = fs.readFileSync(declarationPath, 'utf8')
  if (existing === contents) {
    process.exit(0)
  }
}

fs.writeFileSync(declarationPath, contents)
process.stdout.write(`Created ${path.basename(declarationPath)} for data: imports\n`)
EOF
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

should_use_npm_install() {
  node <<'EOF'
const fs = require('node:fs')

try {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const dependencyGroups = [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.optionalDependencies,
    pkg.peerDependencies,
  ]

  for (const group of dependencyGroups) {
    if (!group || typeof group !== 'object') {
      continue
    }

    for (const version of Object.values(group)) {
      if (typeof version === 'string' && version.startsWith('file:')) {
        process.exit(0)
      }
    }
  }
} catch {}

process.exit(1)
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
DEPLOYMENT_READY_URL="${DEPLOYMENT_URL}/_adapter/status"
DEPLOYMENT_ID="${NEXT_DEPLOYMENT_ID:-next-cloudflare-adapter-local-${PORT}}"

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
export NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}"

ensure_pnpm_shim_on_path >> "${BUILD_LOG}" 2>&1
ensure_python_shim_on_path >> "${BUILD_LOG}" 2>&1
ensure_wrangler_dependency >> "${BUILD_LOG}" 2>&1
INSTALL_WITH_NPM=0

if should_use_npm_install; then
  INSTALL_WITH_NPM=1
  echo "Install strategy: npm (local file: dependencies detected)" >> "${BUILD_LOG}"
  npm install --no-fund --no-audit >> "${BUILD_LOG}" 2>&1
else
  echo "Install strategy: pnpm" >> "${BUILD_LOG}"
  run_pnpm install --strict-peer-dependencies=false --no-frozen-lockfile >> "${BUILD_LOG}" 2>&1
fi
{
  echo "--- test dir layout before local package sync ---"
  find . -maxdepth 2 \( -type d -o -type f \) | sort
  if [ -d "./shared-package" ]; then
    echo "shared-package: present"
    find "./shared-package" -maxdepth 2 \( -type d -o -type f \) | sort
  else
    echo "shared-package: missing"
  fi
} >> "${BUILD_LOG}" 2>&1

if [ "${INSTALL_WITH_NPM}" -eq 0 ]; then
  sync_local_package_dirs_to_node_modules >> "${BUILD_LOG}" 2>&1
fi

ensure_data_url_import_declarations >> "${BUILD_LOG}" 2>&1
{
  echo "--- node_modules/shared-package after local package sync ---"
  if [ -d "./node_modules/shared-package" ]; then
    find "./node_modules/shared-package" -maxdepth 2 \( -type d -o -type f \) | sort
  else
    echo "node_modules/shared-package: missing"
  fi
} >> "${BUILD_LOG}" 2>&1
run_next_build >> "${BUILD_LOG}" 2>&1

BUILD_ID="$(cat ".next/BUILD_ID")"
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
./node_modules/.bin/wrangler dev \
  --config "${WRANGLER_CONFIG}" \
  --ip 127.0.0.1 \
  --port "${PORT}" \
  --inspector-port "${INSPECTOR_PORT}" \
  >> "${SERVER_LOG}" 2>&1 &

WRANGLER_PID="$!"
echo "${WRANGLER_PID}" > "${PID_FILE}"

if ! wait_for_http "${DEPLOYMENT_READY_URL}"; then
  echo "Wrangler did not become ready at ${DEPLOYMENT_READY_URL}" >&2
  exit 1
fi

DEPLOYMENT_READY=1
printf '%s\n' "${DEPLOYMENT_URL}"
