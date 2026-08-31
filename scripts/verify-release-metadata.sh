#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo 'usage: verify-release-metadata.sh [version]' >&2
  exit 2
fi

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
version=${1:-0.3.0}
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
lock_name_1=$(sed -n 's/^[[:space:]]*"name": "\([^"]*\)",$/\1/p' web/package-lock.json | sed -n '1p')
lock_name_2=$(sed -n 's/^[[:space:]]*"name": "\([^"]*\)",$/\1/p' web/package-lock.json | sed -n '2p')
[[ $lock_name_1 == leviathan-dashboard && $lock_name_2 == leviathan-dashboard ]]
lock_version_1=$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",$/\1/p' web/package-lock.json | sed -n '1p')
lock_version_2=$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",$/\1/p' web/package-lock.json | sed -n '2p')
[[ $lock_version_1 == "$version" && $lock_version_2 == "$version" ]]

grep -Fx 'module github.com/intellisys-stevens/leviathan' go.mod >/dev/null
grep -Fxq -- "  --version $version \\" README.md
grep -Fxq -- "  --version $version \\" docs/kubernetes-attribution.md
grep -Fx 'name: leviathan-attribution' charts/leviathan-attribution/Chart.yaml >/dev/null
grep -F 'repository: ghcr.io/intellisys-stevens/leviathan-kubernetes-bridge' charts/leviathan-attribution/values.yaml >/dev/null
grep -F 'ExecStart=/usr/local/bin/leviathan ' contrib/systemd/leviathan@.service >/dev/null
grep -F 'EnvironmentFile=-/etc/leviathan/leviathan.env' contrib/systemd/leviathan@.service >/dev/null
grep -Fx '  title: Leviathan fleet API' api/fleet-openapi.yaml >/dev/null
grep -F 'operationId: getFleetState' api/fleet-openapi.yaml >/dev/null
grep -F 'operationId: putFleetUplinkSnapshot' api/fleet-openapi.yaml >/dev/null
grep -Fx 'EnvironmentFile=/etc/leviathan/uplink-%i.env' contrib/systemd/leviathan-uplink@.service >/dev/null
grep -Fx "ExecStart=/usr/local/bin/leviathan uplink --hub-url=\${LEVIATHAN_HUB_URL} --token-env=LEVIATHAN_UPLINK_TOKEN --uplink-interval=15s" contrib/systemd/leviathan-uplink@.service >/dev/null
grep -Fx 'LEVIATHAN_HUB_URL=https://leviathan-hub.example.test' contrib/systemd/leviathan-uplink.env.example >/dev/null
grep -Fx 'LEVIATHAN_UPLINK_TOKEN=' contrib/systemd/leviathan-uplink.env.example >/dev/null
[[ -f cmd/leviathan-hub/main.go ]]
grep -F 'ENTRYPOINT ["/leviathan-kubernetes-bridge"]' contrib/container/leviathan-kubernetes-bridge.Dockerfile >/dev/null

printf 'verified Leviathan release metadata: %s\n' "$version"
