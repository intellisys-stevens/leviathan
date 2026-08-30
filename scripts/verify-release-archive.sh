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
  "${archive_root}/LICENSE" \
  "${archive_root}/NOTICE" \
  "${archive_root}/README.md" \
  "${archive_root}/openapi.yaml" \
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
grep -Fx 'MIT License' "${root}/LICENSE" >/dev/null
grep -F 'Copyright 2026 MIGLens contributors' "${root}/NOTICE" >/dev/null

version_output="$("${root}/miglens" version --format json)"
grep -F "\"version\":\"${version}\"" <<<"${version_output}" >/dev/null

if strings -a "${root}/miglens" | grep -Ei '(/home/[^/[:space:]]+/|/Users/[^/[:space:]]+/|(MIG-)?GPU-[0-9a-f]{8}-[0-9a-f-]{27})' >/dev/null; then
  echo "binary contains a host path or hardware identifier" >&2
  exit 1
fi

echo "release archive verified: ${expected_name}"
