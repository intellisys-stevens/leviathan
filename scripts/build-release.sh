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
[[ "${release_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "release VERSION must be stable semver: ${version}" >&2
  exit 1
}
case "${architecture}" in
  amd64 | arm64) ;;
  *) echo "unsupported release architecture: ${architecture}" >&2; exit 1 ;;
esac
archive_root="leviathan_${release_version}_linux_${architecture}"
archive="${output_directory}/leviathan_linux_${architecture}.tar.gz"
stage_parent="$(mktemp -d)"
stage="${stage_parent}/${archive_root}"

cleanup() {
  rm -rf -- "${stage_parent}"
}
trap cleanup EXIT

mkdir -p "${stage}/THIRD_PARTY_LICENSES/assets" "${output_directory}"
CGO_CFLAGS="${CGO_CFLAGS:--Wno-deprecated-declarations}" "${go_command}" build \
  -trimpath -buildvcs=false \
  -ldflags "-s -w -X github.com/intellisys-stevens/leviathan/internal/cli.Version=${release_version} -X github.com/intellisys-stevens/leviathan/internal/cli.Commit=${commit} -X github.com/intellisys-stevens/leviathan/internal/cli.BuildDate=${build_date}" \
  -o "${stage}/leviathan" ./cmd/leviathan

command -v objdump >/dev/null 2>&1 || {
  echo "objdump is required to verify the glibc baseline" >&2
  exit 1
}
required_glibc="$({
  objdump -T "${stage}/leviathan" |
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

cp LICENSE NOTICE README.md CHANGELOG.md CONTRIBUTING.md SECURITY.md "${stage}/"
cp contrib/systemd/leviathan@.service "${stage}/"
cp contrib/systemd/leviathan.env.example contrib/systemd/leviathan-attribution.env "${stage}/"
mkdir -p "${stage}/leviathan@root.service.d"
cp contrib/systemd/leviathan@root.service.d/10-hardening.conf "${stage}/leviathan@root.service.d/"
cp contrib/systemd/leviathan@root.service.d/20-uplink.example.conf "${stage}/leviathan@root.service.d/"
mkdir -p "${stage}/api" "${stage}/charts" "${stage}/contrib" "${stage}/web/public"
cp -R charts/leviathan-attribution "${stage}/charts/"
cp -R contrib/systemd "${stage}/contrib/"
cp -R docs "${stage}/"
cp -R licenses "${stage}/"
cp api/openapi.yaml "${stage}/api/openapi.yaml"
cp web/public/leviathan-mark.svg "${stage}/web/public/leviathan-mark.svg"
cp api/openapi.yaml "${stage}/openapi.yaml"
cp licenses/* "${stage}/THIRD_PARTY_LICENSES/assets/"
CGO_CFLAGS="${CGO_CFLAGS:--Wno-deprecated-declarations}" "${go_command}" run github.com/google/go-licenses/v2@v2.0.1 save ./cmd/leviathan --save_path "${stage}/THIRD_PARTY_LICENSES/go" >&2
# The project license and historical NOTICE are already present at archive root;
# keep THIRD_PARTY_LICENSES limited to dependencies.
rm -rf -- "${stage}/THIRD_PARTY_LICENSES/go/github.com/intellisys-stevens/leviathan"
"${node_command}" web/scripts/save-licenses.mjs "${stage}/THIRD_PARTY_LICENSES/web" >&2

tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@${source_date_epoch}" -C "${stage_parent}" -cf - "${archive_root}" | gzip -n -9 > "${archive}"
echo "${archive}"
