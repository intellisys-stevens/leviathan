#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: verify-release-archive.sh <archive> <version> <architecture>" >&2
  exit 2
fi

archive=$1
version=${2#v}
architecture=$3
expected_name="miglens_linux_${architecture}.tar.gz"
archive_root="miglens_${version}_linux_${architecture}"
temporary_directory="$(mktemp -d)"

cleanup() {
  rm -rf -- "${temporary_directory}"
}
trap cleanup EXIT

[[ -f "${archive}" ]] || { echo "archive not found: ${archive}" >&2; exit 1; }
[[ "$(basename "${archive}")" == "${expected_name}" ]] || {
  echo "unexpected archive name: $(basename "${archive}")" >&2
  exit 1
}

archive_entries="$(tar -tzf "${archive}")"
[[ -n "${archive_entries}" ]]
if ! awk -v root="${archive_root}/" 'index($0, root) != 1 { exit 1 }' <<<"${archive_entries}"; then
  echo "archive contains an entry outside ${archive_root}" >&2
  exit 1
fi

for required_path in \
  "${archive_root}/miglens" \
  "${archive_root}/miglens-hub" \
  "${archive_root}/LICENSE" \
  "${archive_root}/NOTICE" \
  "${archive_root}/README.md" \
  "${archive_root}/CONTRIBUTING.md" \
  "${archive_root}/SECURITY.md" \
  "${archive_root}/miglens@.service" \
  "${archive_root}/miglens.env.example" \
  "${archive_root}/miglens-attribution.env" \
  "${archive_root}/miglens-uplink@.service" \
  "${archive_root}/miglens-uplink.env.example" \
  "${archive_root}/miglens@root.service.d/10-hardening.conf" \
  "${archive_root}/contrib/systemd/miglens@.service" \
  "${archive_root}/contrib/systemd/miglens.env.example" \
  "${archive_root}/contrib/systemd/miglens-attribution.env" \
  "${archive_root}/contrib/systemd/miglens-uplink@.service" \
  "${archive_root}/contrib/systemd/miglens-uplink.env.example" \
  "${archive_root}/contrib/systemd/miglens@root.service.d/10-hardening.conf" \
  "${archive_root}/charts/miglens-attribution/Chart.yaml" \
  "${archive_root}/charts/miglens-attribution/values.yaml" \
  "${archive_root}/charts/miglens-attribution/values.schema.json" \
  "${archive_root}/charts/miglens-attribution/templates/daemonset.yaml" \
  "${archive_root}/charts/miglens-attribution/templates/rbac.yaml" \
  "${archive_root}/docs/architecture.md" \
  "${archive_root}/docs/assets/architecture.svg" \
  "${archive_root}/docs/config.example.toml" \
  "${archive_root}/docs/jetstream-fleet.md" \
  "${archive_root}/docs/kubernetes-attribution.md" \
  "${archive_root}/docs/permissions.md" \
  "${archive_root}/api/fleet-openapi.yaml" \
  "${archive_root}/api/openapi.yaml" \
  "${archive_root}/web/public/miglens-mark.png" \
  "${archive_root}/openapi.yaml" \
  "${archive_root}/licenses/OFL-1.1.txt" \
  "${archive_root}/licenses/SHADCN-MIT.txt" \
  "${archive_root}/THIRD_PARTY_LICENSES/assets/OFL-1.1.txt" \
  "${archive_root}/THIRD_PARTY_LICENSES/assets/SHADCN-MIT.txt" \
  "${archive_root}/THIRD_PARTY_LICENSES/web/THIRD_PARTY_NOTICES.txt"; do
  grep -Fx -- "${required_path}" <<<"${archive_entries}" >/dev/null || {
    echo "archive is missing ${required_path}" >&2
    exit 1
  }
done

tar -xzf "${archive}" -C "${temporary_directory}"
root="${temporary_directory}/${archive_root}"
[[ -x "${root}/miglens" ]] || { echo "miglens is not executable" >&2; exit 1; }
[[ -x "${root}/miglens-hub" ]] || { echo "miglens-hub is not executable" >&2; exit 1; }
grep -Fx 'User=%i' "${root}/miglens@.service" >/dev/null
grep -Fx 'ExecStart=/usr/local/bin/miglens --listen 127.0.0.1:1397 serve' "${root}/miglens@.service" >/dev/null
grep -Fx 'EnvironmentFile=-/etc/miglens/miglens.env' "${root}/miglens@.service" >/dev/null
grep -Fx '# MIGLENS_ATTRIBUTION_SOCKET=/run/miglens/attribution.sock' "${root}/miglens.env.example" >/dev/null
grep -Fx 'MIGLENS_ATTRIBUTION_SOCKET=/run/miglens/attribution.sock' "${root}/miglens-attribution.env" >/dev/null

uplink_units=(
  "${root}/miglens-uplink@.service"
  "${root}/contrib/systemd/miglens-uplink@.service"
)
for uplink_unit in "${uplink_units[@]}"; do
  grep -Fx 'User=%i' "${uplink_unit}" >/dev/null
  grep -Fx 'EnvironmentFile=/etc/miglens/uplink-%i.env' "${uplink_unit}" >/dev/null
  grep -Fx 'ExecStart=/usr/local/bin/miglens uplink --hub-url=${MIGLENS_HUB_URL} --token-env=MIGLENS_UPLINK_TOKEN --uplink-interval=15s' "${uplink_unit}" >/dev/null
  for directive in User EnvironmentFile ExecStart; do
    [[ "$(grep -c "^${directive}=" "${uplink_unit}")" -eq 1 ]] || {
      echo "uplink systemd unit must contain exactly one ${directive} directive" >&2
      exit 1
    }
  done
done
cmp "${uplink_units[0]}" "${uplink_units[1]}" >/dev/null

uplink_examples=(
  "${root}/miglens-uplink.env.example"
  "${root}/contrib/systemd/miglens-uplink.env.example"
)
for uplink_example in "${uplink_examples[@]}"; do
  grep -Fx 'MIGLENS_HUB_URL=https://miglens-hub.example.test' "${uplink_example}" >/dev/null
  grep -Fx 'MIGLENS_UPLINK_TOKEN=' "${uplink_example}" >/dev/null
  [[ "$(grep -c '^MIGLENS_UPLINK_TOKEN=' "${uplink_example}")" -eq 1 ]] || {
    echo "uplink environment example must contain exactly one token placeholder" >&2
    exit 1
  }
  if grep -Ei '^[[:space:]]*[A-Z_]*(TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*=[[:space:]]*[^[:space:]#]+' "${uplink_example}" >/dev/null; then
    echo "uplink environment example must not contain a credential value" >&2
    exit 1
  fi
  if grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "${uplink_example}" |
    grep -Ev '^(MIGLENS_HUB_URL=https://miglens-hub\.example\.test|MIGLENS_UPLINK_TOKEN=)$' >/dev/null; then
    echo "uplink environment example contains an unexpected assignment" >&2
    exit 1
  fi
done
cmp "${uplink_examples[0]}" "${uplink_examples[1]}" >/dev/null

root_hardening="${root}/miglens@root.service.d/10-hardening.conf"
for directive in \
  'CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_SYS_PTRACE' \
  'ProtectProc=default' \
  'ProcSubset=all' \
  'ProtectSystem=strict' \
  'ProtectHome=true' \
  'IPAddressDeny=any' \
  'IPAddressAllow=localhost'; do
  grep -Fx "${directive}" "${root_hardening}" >/dev/null
done
if grep -F -- '--show-command-line' "${root_hardening}" >/dev/null; then
  echo "root systemd drop-in must not expose process command lines" >&2
  exit 1
fi
grep -Fx 'MIT License' "${root}/LICENSE" >/dev/null
grep -F 'Copyright 2026 MIGLens contributors' "${root}/NOTICE" >/dev/null
cmp "${root}/openapi.yaml" "${root}/api/openapi.yaml" >/dev/null

version_output="$("${root}/miglens" version --format json)"
grep -F "\"version\":\"${version}\"" <<<"${version_output}" >/dev/null
hub_version_output="$("${root}/miglens-hub" version --json)"
grep -F "\"version\":\"${version}\"" <<<"${hub_version_output}" >/dev/null
grep -Fx "  version: ${version}" "${root}/openapi.yaml" >/dev/null
grep -Fx -- "  --version ${version} \\" "${root}/README.md" >/dev/null
grep -Fx -- "  --version ${version} \\" "${root}/docs/kubernetes-attribution.md" >/dev/null

chart="${root}/charts/miglens-attribution/Chart.yaml"
grep -Fx "version: ${version}" "${chart}" >/dev/null || {
  echo "Helm chart version does not match archive version ${version}" >&2
  exit 1
}
grep -Fx "appVersion: \"${version}\"" "${chart}" >/dev/null || {
  echo "Helm chart appVersion does not match archive version ${version}" >&2
  exit 1
}
grep -Fx 'kubeVersion: ">=1.34.0-0"' "${chart}" >/dev/null
grep -F 'workspaceNamespaces:' "${root}/charts/miglens-attribution/values.yaml" >/dev/null
grep -F 'readOnlyRootFilesystem: true' "${root}/charts/miglens-attribution/values.yaml" >/dev/null
grep -F 'resources: ["resourceslices"]' "${root}/charts/miglens-attribution/templates/rbac.yaml" >/dev/null
grep -F 'resources: ["resourceclaims"]' "${root}/charts/miglens-attribution/templates/rbac.yaml" >/dev/null

for binary in miglens miglens-hub; do
  if strings -a "${root}/${binary}" | grep -Ei '(/home/[^/[:space:]]+/|/Users/[^/[:space:]]+/|(MIG-)?GPU-[0-9a-f]{8}-[0-9a-f-]{27})' >/dev/null; then
    echo "${binary} contains a host path or hardware identifier" >&2
    exit 1
  fi
done

echo "release archive verified: ${expected_name}"
