#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Reject obsolete configuration even when only help is requested.
for legacy_variable in MIGLENS_VERSION MIGLENS_INSTALL_DIR MIGLENS_FUTURE_SETTING; do
  if output=$(env "${legacy_variable}=legacy" /bin/sh "${repository_root}/scripts/install.sh" --help 2>&1); then
    echo "install test: legacy environment unexpectedly accepted" >&2
    exit 1
  fi
  expected="legacy environment variable ${legacy_variable} is no longer supported; rename it to LEVIATHAN_${legacy_variable#MIGLENS_}"
  grep -F -- "$expected" <<< "$output" >/dev/null
done

python3 "${repository_root}/scripts/install-default-test.py"
