#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 /absolute/or/relative/path/to/fixture" >&2
  exit 1
fi

FIXTURE_INPUT="$1"

if [ -d "${FIXTURE_INPUT}" ]; then
  FIXTURE_DIR="$(cd "${FIXTURE_INPUT}" && pwd)"
else
  echo "Fixture directory not found: ${FIXTURE_INPUT}" >&2
  exit 1
fi

DEBUG_ROOT="${TMPDIR:-/tmp}"
TEMP_DIR="$(mktemp -d "${DEBUG_ROOT%/}/next-adapter-debug.XXXXXX")"

cleanup_on_error() {
  local exit_code="$1"

  if [ "${exit_code}" -eq 0 ]; then
    return
  fi

  if [ -d "${TEMP_DIR}" ]; then
    (
      cd "${TEMP_DIR}"
      "${REPO_DIR}/scripts/e2e-cleanup.sh" >/dev/null 2>&1 || true
    )
    rm -rf "${TEMP_DIR}"
  fi
}

trap 'cleanup_on_error "$?"' EXIT

copy_fixture_files() {
  if command -v rsync >/dev/null 2>&1; then
    rsync -a \
      --exclude='*.test.*' \
      --exclude='*.results.json' \
      --exclude='app-dir.test.ts' \
      --exclude='pages-dir.test.ts' \
      --exclude='shared-tests.util.ts' \
      "${FIXTURE_DIR}/" "${TEMP_DIR}/"
    return
  fi

  cp -R "${FIXTURE_DIR}/." "${TEMP_DIR}/"
  find "${TEMP_DIR}" \
    \( -name '*.test.*' -o -name '*.results.json' -o -name 'app-dir.test.ts' -o -name 'pages-dir.test.ts' -o -name 'shared-tests.util.ts' \) \
    -delete
}

copy_fixture_files

if [ ! -f "${TEMP_DIR}/package.json" ]; then
  cat > "${TEMP_DIR}/package.json" <<'EOF'
{
  "name": "next-adapter-debug-fixture",
  "private": true,
  "dependencies": {
    "next": "16.2.2",
    "react": "19.2.4",
    "react-dom": "19.2.4"
  },
  "devDependencies": {
    "@types/node": "25.5.2",
    "@types/react": "19.2.2",
    "@types/react-dom": "19.2.1",
    "typescript": "6.0.2"
  }
}
EOF
fi

DEPLOY_URL="$(
  cd "${TEMP_DIR}"
  ADAPTER_DIR="${REPO_DIR}" \
  NEXT_TEST_DIR="${FIXTURE_DIR}" \
  "${REPO_DIR}/scripts/e2e-deploy.sh"
)"

cat <<EOF
Fixture source: ${FIXTURE_DIR}
Debug app dir: ${TEMP_DIR}
Local URL: ${DEPLOY_URL}

Logs:
  cd "${TEMP_DIR}" && "${REPO_DIR}/scripts/e2e-logs.sh"

Cleanup:
  cd "${TEMP_DIR}" && "${REPO_DIR}/scripts/e2e-cleanup.sh"
EOF
