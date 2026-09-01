#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: verify-release-archive.sh <archive> <version> <architecture>" >&2
  exit 2
fi

archive=$1
version=${2#v}
architecture=$3
[[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "archive version must be stable semver: ${2}" >&2
  exit 1
}
case "${architecture}" in
  amd64 | arm64) ;;
  *) echo "unsupported release architecture: ${architecture}" >&2; exit 1 ;;
esac
expected_name="leviathan_linux_${architecture}.tar.gz"
archive_root="leviathan_${version}_linux_${architecture}"
temporary_directory="$(mktemp -d)"
legacy_name='mig'
legacy_name+='lens'

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
if grep -Ei -- "${legacy_name}" <<<"${archive_entries}" >/dev/null; then
  echo "archive contains a legacy-named path" >&2
  exit 1
fi
if grep -F -- "/web/e2e/fixtures/" <<<"${archive_entries}" >/dev/null; then
  echo "release archive must not contain branding reference fixtures" >&2
  exit 1
fi
if ! awk -v root="${archive_root}/" 'index($0, root) != 1 { exit 1 }' <<<"${archive_entries}"; then
  echo "archive contains an entry outside ${archive_root}" >&2
  exit 1
fi

for required_path in \
  "${archive_root}/leviathan" \
  "${archive_root}/leviathan-hub" \
  "${archive_root}/LICENSE" \
  "${archive_root}/NOTICE" \
  "${archive_root}/README.md" \
  "${archive_root}/CONTRIBUTING.md" \
  "${archive_root}/SECURITY.md" \
  "${archive_root}/leviathan@.service" \
  "${archive_root}/leviathan.env.example" \
  "${archive_root}/leviathan-attribution.env" \
  "${archive_root}/leviathan-uplink@.service" \
  "${archive_root}/leviathan-uplink.env.example" \
  "${archive_root}/leviathan@root.service.d/10-hardening.conf" \
  "${archive_root}/contrib/systemd/leviathan@.service" \
  "${archive_root}/contrib/systemd/leviathan.env.example" \
  "${archive_root}/contrib/systemd/leviathan-attribution.env" \
  "${archive_root}/contrib/systemd/leviathan-uplink@.service" \
  "${archive_root}/contrib/systemd/leviathan-uplink.env.example" \
  "${archive_root}/contrib/systemd/leviathan@root.service.d/10-hardening.conf" \
  "${archive_root}/charts/leviathan-attribution/Chart.yaml" \
  "${archive_root}/charts/leviathan-attribution/values.yaml" \
  "${archive_root}/charts/leviathan-attribution/values.schema.json" \
  "${archive_root}/charts/leviathan-attribution/templates/daemonset.yaml" \
  "${archive_root}/charts/leviathan-attribution/templates/rbac.yaml" \
  "${archive_root}/docs/architecture.md" \
  "${archive_root}/docs/assets/architecture.svg" \
  "${archive_root}/docs/config.example.toml" \
  "${archive_root}/docs/jetstream-fleet.md" \
  "${archive_root}/docs/deployment.md" \
  "${archive_root}/docs/kubernetes-attribution.md" \
  "${archive_root}/docs/migration-v0.3.md" \
  "${archive_root}/docs/permissions.md" \
  "${archive_root}/docs/releasing.md" \
  "${archive_root}/api/fleet-openapi.yaml" \
  "${archive_root}/docs/security-and-privacy.md" \
  "${archive_root}/api/openapi.yaml" \
  "${archive_root}/web/public/leviathan-mark.svg" \
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

while IFS= read -r -d '' file; do
  relative=${file#"${root}/"}
  case "${relative}" in
    leviathan | LICENSE | NOTICE | docs/migration-v0.3.md | docs/releasing.md) continue ;;
  esac
  if grep -In -i -- "${legacy_name}" "${file}" >/dev/null 2>&1; then
    echo "archive contains an unexpected legacy product reference: ${relative}" >&2
    exit 1
  fi
done < <(find "${root}" -type f -print0)

[[ -x "${root}/leviathan" ]] || { echo "leviathan is not executable" >&2; exit 1; }
[[ -x "${root}/leviathan-hub" ]] || { echo "leviathan-hub is not executable" >&2; exit 1; }
grep -Fx 'User=%i' "${root}/leviathan@.service" >/dev/null
grep -Fx 'ExecStart=/usr/local/bin/leviathan --listen 127.0.0.1:1397 serve' "${root}/leviathan@.service" >/dev/null
grep -Fx 'EnvironmentFile=-/etc/leviathan/leviathan.env' "${root}/leviathan@.service" >/dev/null
grep -Fx '# LEVIATHAN_ATTRIBUTION_SOCKET=/run/leviathan/attribution.sock' "${root}/leviathan.env.example" >/dev/null
grep -Fx 'LEVIATHAN_ATTRIBUTION_SOCKET=/run/leviathan/attribution.sock' "${root}/leviathan-attribution.env" >/dev/null

uplink_units=(
  "${root}/leviathan-uplink@.service"
  "${root}/contrib/systemd/leviathan-uplink@.service"
)
for uplink_unit in "${uplink_units[@]}"; do
  grep -Fx 'User=%i' "${uplink_unit}" >/dev/null
  grep -Fx 'EnvironmentFile=/etc/leviathan/uplink-%i.env' "${uplink_unit}" >/dev/null
  grep -Fx "ExecStart=/usr/local/bin/leviathan --interval=500ms uplink --hub-url=\${LEVIATHAN_HUB_URL} --token-env=LEVIATHAN_UPLINK_TOKEN --uplink-interval=500ms" "${uplink_unit}" >/dev/null
  for directive in User EnvironmentFile ExecStart; do
    [[ "$(grep -c "^${directive}=" "${uplink_unit}")" -eq 1 ]] || {
      echo "uplink systemd unit must contain exactly one ${directive} directive" >&2
      exit 1
    }
  done
done
cmp "${uplink_units[0]}" "${uplink_units[1]}" >/dev/null

uplink_examples=(
  "${root}/leviathan-uplink.env.example"
  "${root}/contrib/systemd/leviathan-uplink.env.example"
)
for uplink_example in "${uplink_examples[@]}"; do
  grep -Fx 'LEVIATHAN_HUB_URL=https://leviathan-hub.example.test' "${uplink_example}" >/dev/null
  grep -Fx 'LEVIATHAN_UPLINK_TOKEN=' "${uplink_example}" >/dev/null
  [[ "$(grep -c '^LEVIATHAN_UPLINK_TOKEN=' "${uplink_example}")" -eq 1 ]] || {
    echo "uplink environment example must contain exactly one token placeholder" >&2
    exit 1
  }
  if grep -Ei '^[[:space:]]*[A-Z_]*(TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*=[[:space:]]*[^[:space:]#]+' "${uplink_example}" >/dev/null; then
    echo "uplink environment example must not contain a credential value" >&2
    exit 1
  fi
  if grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "${uplink_example}" |
    grep -Ev '^(LEVIATHAN_HUB_URL=https://leviathan-hub\.example\.test|LEVIATHAN_UPLINK_TOKEN=)$' >/dev/null; then
    echo "uplink environment example contains an unexpected assignment" >&2
    exit 1
  fi
done
cmp "${uplink_examples[0]}" "${uplink_examples[1]}" >/dev/null

root_hardening="${root}/leviathan@root.service.d/10-hardening.conf"
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
grep -F 'Leviathan (formerly MIGLens)' "${root}/NOTICE" >/dev/null
grep -F 'Copyright (c) 2026 MIGLens contributors' "${root}/LICENSE" >/dev/null
grep -F 'Leviathan frost-dragon mark traces a project-owner-supplied source image' "${root}/NOTICE" >/dev/null
mark="${root}/web/public/leviathan-mark.svg"
[[ "$(wc -c <"${mark}")" -lt 8192 ]] || {
  echo "frost-dragon mark exceeds 8 KiB" >&2
  exit 1
}
grep -F '<title id="title">Leviathan frost-dragon mark</title>' "${mark}" >/dev/null
grep -F 'viewBox="0 0 64 64"' "${mark}" >/dev/null
grep -F '.mark{fill:#15364b}' "${mark}" >/dev/null
grep -F '.mark{fill:#8be4ff}' "${mark}" >/dev/null
grep -F 'data-source-sha256="1556d8fe7da4af39b968f84d56afe5d8531a152cba3338e268a8ece8a3ddbe4b"' "${mark}" >/dev/null
if grep -Ei '<(script|foreignobject|iframe|object|embed|image|text|animate(motion|transform)?|set|lineargradient|radialgradient|pattern|filter)([[:space:]/>])|on[a-z]+[[:space:]]*=|javascript:|(href|xlink:href)[[:space:]]*=' "${mark}" >/dev/null; then
  echo "frost-dragon mark contains active or external content" >&2
  exit 1
fi
cmp "${root}/openapi.yaml" "${root}/api/openapi.yaml" >/dev/null
grep -Fx '  title: Leviathan fleet API' "${root}/api/fleet-openapi.yaml" >/dev/null
grep -F 'operationId: getFleetState' "${root}/api/fleet-openapi.yaml" >/dev/null
grep -F 'operationId: putFleetUplinkSnapshot' "${root}/api/fleet-openapi.yaml" >/dev/null

version_output="$("${root}/leviathan" version --format json)"
grep -F "\"version\":\"${version}\"" <<<"${version_output}" >/dev/null
hub_version_output="$("${root}/leviathan-hub" version --json)"
grep -F "\"version\":\"${version}\"" <<<"${hub_version_output}" >/dev/null
grep -Fx "  version: ${version}" "${root}/openapi.yaml" >/dev/null
grep -Fx -- "  --version ${version} \\" "${root}/docs/kubernetes-attribution.md" >/dev/null

chart="${root}/charts/leviathan-attribution/Chart.yaml"
grep -Fx "version: ${version}" "${chart}" >/dev/null || {
  echo "Helm chart version does not match archive version ${version}" >&2
  exit 1
}
grep -Fx "appVersion: \"${version}\"" "${chart}" >/dev/null || {
  echo "Helm chart appVersion does not match archive version ${version}" >&2
  exit 1
}
grep -Fx 'kubeVersion: ">=1.34.0-0"' "${chart}" >/dev/null
grep -F 'workspaceNamespaces:' "${root}/charts/leviathan-attribution/values.yaml" >/dev/null
grep -F 'readOnlyRootFilesystem: true' "${root}/charts/leviathan-attribution/values.yaml" >/dev/null
grep -F 'resources: ["resourceslices"]' "${root}/charts/leviathan-attribution/templates/rbac.yaml" >/dev/null
grep -F 'resources: ["resourceclaims"]' "${root}/charts/leviathan-attribution/templates/rbac.yaml" >/dev/null

for binary in leviathan leviathan-hub; do
  if strings -a "${root}/${binary}" | grep -Ei '(/home/[^/[:space:]]+/|/Users/[^/[:space:]]+/|(MIG-)?GPU-[0-9a-f]{8}-[0-9a-f-]{27})' >/dev/null; then
    echo "${binary} contains a host path or hardware identifier" >&2
    exit 1
  fi
done

echo "release archive verified: ${expected_name}"
