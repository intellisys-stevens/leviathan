#!/usr/bin/env bash
set -euo pipefail

version="${VERSION:?VERSION is required}"
go_command="${GO:-go}"
node_command="${NODE:-node}"
architecture="${ARCHITECTURE:-$("${go_command}" env GOARCH)}"
output_directory="${OUTPUT_DIRECTORY:-dist}"
native_architecture="$("${go_command}" env GOARCH)"
glibc_baseline="${GLIBC_BASELINE:-2.34}"

if [[ "${architecture}" != "${native_architecture}" ]]; then
  echo "release builds use native CGO runners: requested ${architecture}, running ${native_architecture}" >&2
  exit 1
fi

source_date_epoch="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || date +%s)}"
commit="${COMMIT:-$(git rev-parse --short=12 HEAD 2>/dev/null || printf unknown)}"
build_date="${BUILD_DATE:-$(date -u -d "@${source_date_epoch}" +%Y-%m-%dT%H:%M:%SZ)}"
release_version="${version#v}"
archive_root="miglens_${release_version}_linux_${architecture}"
archive="${output_directory}/miglens_linux_${architecture}.tar.gz"
stage_parent="$(mktemp -d)"
stage="${stage_parent}/${archive_root}"

cleanup() {
  rm -rf -- "${stage_parent}"
}
trap cleanup EXIT

mkdir -p "${stage}/THIRD_PARTY_LICENSES/assets" "${output_directory}"
CGO_CFLAGS="${CGO_CFLAGS:--Wno-deprecated-declarations}" "${go_command}" build \
  -trimpath -buildvcs=false \
  -ldflags "-s -w -X github.com/intellisys-stevens/miglens/internal/cli.Version=${release_version} -X github.com/intellisys-stevens/miglens/internal/cli.Commit=${commit} -X github.com/intellisys-stevens/miglens/internal/cli.BuildDate=${build_date}" \
  -o "${stage}/miglens" ./cmd/miglens

command -v objdump >/dev/null 2>&1 || {
  echo "objdump is required to verify the glibc baseline" >&2
  exit 1
}
required_glibc="$({
  objdump -T "${stage}/miglens" |
    sed -n 's/.*(GLIBC_\([0-9][0-9.]*\)).*/\1/p' |
    LC_ALL=C sort -Vu |
    tail -n 1
} || true)"
if [[ -z "${required_glibc}" ]]; then
  echo "could not determine the binary's glibc requirement" >&2
  exit 1
fi
highest_glibc="$(printf '%s\n%s\n' "${glibc_baseline}" "${required_glibc}" | LC_ALL=C sort -V | tail -n 1)"
if [[ "${highest_glibc}" != "${glibc_baseline}" ]]; then
  echo "binary requires glibc ${required_glibc}, exceeding the ${glibc_baseline} release baseline" >&2
  exit 1
fi
echo "verified glibc requirement ${required_glibc} <= ${glibc_baseline}" >&2

cp LICENSE NOTICE README.md "${stage}/"
cp api/openapi.yaml "${stage}/openapi.yaml"
cp licenses/* "${stage}/THIRD_PARTY_LICENSES/assets/"
CGO_CFLAGS="${CGO_CFLAGS:--Wno-deprecated-declarations}" "${go_command}" run github.com/google/go-licenses/v2@v2.0.1 save ./cmd/miglens --save_path "${stage}/THIRD_PARTY_LICENSES/go" >&2
"${node_command}" web/scripts/save-licenses.mjs "${stage}/THIRD_PARTY_LICENSES/web" >&2

tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@${source_date_epoch}" -C "${stage_parent}" -cf - "${archive_root}" | gzip -n -9 > "${archive}"
echo "${archive}"
