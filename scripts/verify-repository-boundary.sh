#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "${repository_root}"

for forbidden_path in \
  api/fleet-openapi.yaml \
  cmd/leviathan-hub \
  cmd/yggdrasil \
  internal/agentclient \
  internal/fleet \
  internal/fleetapi \
  internal/fleettelemetry \
  internal/fleetuplink \
  internal/hubcli \
  internal/hubconfig \
  internal/jetstream \
  web/src/fleet; do
  if [[ -e "${forbidden_path}" ]]; then
    printf 'Yggdrasil-owned path is present in Leviathan: %s\n' "${forbidden_path}" >&2
    exit 1
  fi
done

if grep -R --include='*.go' --exclude-dir=.git \
  'github.com/intellisys-stevens/yggdrasil' . >/dev/null; then
  echo 'Leviathan must communicate with Yggdrasil over HTTP, not Go imports.' >&2
  exit 1
fi

if grep -F 'github.com/gophercloud/gophercloud' go.mod >/dev/null; then
  echo 'Nova inventory dependencies belong in Yggdrasil, not Leviathan.' >&2
  exit 1
fi

echo 'verified Leviathan agent-only repository boundary'
