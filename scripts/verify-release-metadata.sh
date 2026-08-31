#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo 'usage: verify-release-metadata.sh [version]' >&2
  exit 2
fi

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
version=${1:-0.3.1}
version=${version#v}

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "release version must be stable semver: $version" >&2
  exit 1
}

[[ $(awk '$1 == "version:" { print $2 }' charts/leviathan-attribution/Chart.yaml) == "$version" ]]
[[ $(awk '$1 == "appVersion:" { gsub(/"/, "", $2); print $2 }' charts/leviathan-attribution/Chart.yaml) == "$version" ]]
[[ $(sed -n 's/^  version: //p' api/openapi.yaml | head -n 1) == "$version" ]]
[[ $(sed -n 's/^[[:space:]]*"name": "\([^"]*\)",$/\1/p' web/package.json | head -n 1) == leviathan-dashboard ]]
[[ $(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",$/\1/p' web/package.json | head -n 1) == "$version" ]]
mapfile -t lock_names < <(sed -n 's/^[[:space:]]*"name": "\([^"]*\)",$/\1/p' web/package-lock.json | head -n 2)
[[ ${#lock_names[@]} -eq 2 ]]
[[ ${lock_names[0]} == leviathan-dashboard && ${lock_names[1]} == leviathan-dashboard ]]
mapfile -t lock_versions < <(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",$/\1/p' web/package-lock.json | head -n 2)
[[ ${#lock_versions[@]} -eq 2 ]]
[[ ${lock_versions[0]} == "$version" && ${lock_versions[1]} == "$version" ]]

grep -Fx 'module github.com/intellisys-stevens/leviathan' go.mod >/dev/null
grep -Fxq -- "  --version $version \\" docs/kubernetes-attribution.md
grep -Fx 'name: leviathan-attribution' charts/leviathan-attribution/Chart.yaml >/dev/null
grep -F 'repository: ghcr.io/intellisys-stevens/leviathan-kubernetes-bridge' charts/leviathan-attribution/values.yaml >/dev/null
grep -F 'ExecStart=/usr/local/bin/leviathan ' contrib/systemd/leviathan@.service >/dev/null
grep -F 'EnvironmentFile=-/etc/leviathan/leviathan.env' contrib/systemd/leviathan@.service >/dev/null
grep -F 'ENTRYPOINT ["/leviathan-kubernetes-bridge"]' contrib/container/leviathan-kubernetes-bridge.Dockerfile >/dev/null

printf 'verified Leviathan release metadata: %s\n' "$version"
