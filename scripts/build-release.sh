#!/usr/bin/env bash
set -euo pipefail

version="${VERSION:?VERSION is required}"
architecture="${ARCHITECTURE:-$(go env GOARCH)}"
output_directory="${OUTPUT_DIRECTORY:-dist}"
native_architecture="$(go env GOARCH)"

if [[ "${architecture}" != "${native_architecture}" ]]; then
  echo "release builds use native CGO runners: requested ${architecture}, running ${native_architecture}" >&2
  exit 1
fi

source_date_epoch="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || date +%s)}"
commit="${COMMIT:-$(git rev-parse --short=12 HEAD 2>/dev/null || printf unknown)}"
build_date="${BUILD_DATE:-$(date -u -d "@${source_date_epoch}" +%Y-%m-%dT%H:%M:%SZ)}"
release_version="${version#v}"
archive_root="miglens_${release_version}_linux_${architecture}"
archive="${output_directory}/${archive_root}.tar.gz"
stage_parent="$(mktemp -d)"
stage="${stage_parent}/${archive_root}"

cleanup() {
  rm -rf -- "${stage_parent}"
}
trap cleanup EXIT

mkdir -p "${stage}/THIRD_PARTY_LICENSES/assets" "${output_directory}"
CGO_CFLAGS="${CGO_CFLAGS:--Wno-deprecated-declarations}" go build \
  -trimpath -buildvcs=false \
  -ldflags "-s -w -X github.com/miglens/miglens/internal/cli.Version=${release_version} -X github.com/miglens/miglens/internal/cli.Commit=${commit} -X github.com/miglens/miglens/internal/cli.BuildDate=${build_date}" \
  -o "${stage}/miglens" ./cmd/miglens

cp LICENSE NOTICE README.md "${stage}/"
cp api/openapi.yaml "${stage}/openapi.yaml"
cp licenses/* "${stage}/THIRD_PARTY_LICENSES/assets/"
CGO_CFLAGS="${CGO_CFLAGS:--Wno-deprecated-declarations}" go run github.com/google/go-licenses/v2@v2.0.1 save ./cmd/miglens --save_path "${stage}/THIRD_PARTY_LICENSES/go"
node web/scripts/save-licenses.mjs "${stage}/THIRD_PARTY_LICENSES/web"

tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@${source_date_epoch}" -C "${stage_parent}" -cf - "${archive_root}" | gzip -n -9 > "${archive}"
echo "${archive}"
