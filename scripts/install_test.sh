#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
installer="${repository_root}/scripts/install.sh"
test_root="$(mktemp -d)"
test_root="$(cd -P "${test_root}" && pwd)"

cleanup() {
  rm -rf -- "${test_root}"
}
trap cleanup EXIT

fail() {
  echo "install test: $*" >&2
  exit 1
}

assert_contains() {
  local file=$1
  local expected=$2
  grep -F -- "${expected}" "${file}" >/dev/null || fail "${file} does not contain: ${expected}"
}

assert_not_contains() {
  local file=$1
  local unexpected=$2
  if grep -F -- "${unexpected}" "${file}" >/dev/null; then
    fail "${file} unexpectedly contains: ${unexpected}"
  fi
}

assert_failed() {
  local output=$1
  shift
  if "$@" >"${output}" 2>&1; then
    fail "command unexpectedly succeeded: $*"
  fi
}

release_directory="${test_root}/release"
fixture_root="${test_root}/fixtures"
fake_bin="${test_root}/fake-bin"
mkdir -p "${release_directory}" "${fixture_root}" "${fake_bin}"
sha256sum_path=$(command -v sha256sum) || fail "sha256sum is required to run installer tests"
ln -s "${sha256sum_path}" "${fake_bin}/sha256sum"

create_archive() {
  local architecture=$1
  local marker=$2
  local version=${3:-0.3.0}
  local root="${fixture_root}/leviathan_${version}_linux_${architecture}"
  rm -rf -- "${root}"
  mkdir -p "${root}"
  printf '#!/bin/sh\nprintf "%%s\\n" "%s"\n' "${marker}" >"${root}/leviathan"
  chmod 0755 "${root}/leviathan"
  tar -C "${fixture_root}" -czf "${release_directory}/leviathan_linux_${architecture}.tar.gz" "$(basename "${root}")"
}

write_checksums() {
  (
    cd "${release_directory}"
    sha256sum leviathan_linux_amd64.tar.gz leviathan_linux_arm64.tar.gz >checksums.txt
  )
}

create_archive amd64 fixture-amd64
create_archive arm64 fixture-arm64
write_checksums

cat >"${fake_bin}/uname" <<'EOF'
#!/bin/sh
case "${1:-}" in
  -s) printf '%s\n' "${FAKE_UNAME_S:-Linux}" ;;
  -m) printf '%s\n' "${FAKE_UNAME_M:-x86_64}" ;;
  *) exit 2 ;;
esac
EOF

cat >"${fake_bin}/getconf" <<'EOF'
#!/bin/sh
[ "${1:-}" = "GNU_LIBC_VERSION" ] || exit 2
[ "${FAKE_GLIBC_INFO:-glibc 2.34}" != "unavailable" ] || exit 1
printf '%s\n' "${FAKE_GLIBC_INFO:-glibc 2.34}"
EOF

cat >"${fake_bin}/curl" <<'EOF'
#!/bin/sh
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o | --output)
      shift
      output=${1:?missing curl output}
      ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
[ -n "$output" ] && [ -n "$url" ]
printf '%s\n' "$url" >>"${FAKE_CURL_LOG:?}"
asset=${url##*/}
cp "${FAKE_RELEASE_DIR:?}/${asset}" "$output"
EOF

chmod 0755 "${fake_bin}/uname" "${fake_bin}/getconf" "${fake_bin}/curl"

run_installer() {
  local output=$1
  local home=$2
  local log=$3
  local release=$4
  shift 4
  env -u LEVIATHAN_VERSION -u LEVIATHAN_INSTALL_DIR \
    PATH="${fake_bin}:/usr/bin:/bin" \
    HOME="${home}" SHELL=/bin/bash \
    FAKE_CURL_LOG="${log}" FAKE_RELEASE_DIR="${release}" \
    FAKE_UNAME_S="${FAKE_UNAME_S:-Linux}" \
    FAKE_UNAME_M="${FAKE_UNAME_M:-x86_64}" \
    FAKE_GLIBC_INFO="${FAKE_GLIBC_INFO:-glibc 2.34}" \
    /bin/sh "${installer}" "$@" >"${output}" 2>&1
}

# Every legacy-prefixed environment variable is rejected before option handling
# so a stale installer configuration cannot silently select latest or $HOME.
for legacy_variable in MIGLENS_VERSION MIGLENS_INSTALL_DIR MIGLENS_FUTURE_SETTING; do
  case_directory="${test_root}/legacy-${legacy_variable}"
  mkdir -p "${case_directory}/home"
  assert_failed "${case_directory}/output" env \
    -u LEVIATHAN_VERSION -u LEVIATHAN_INSTALL_DIR \
    PATH="${fake_bin}:/usr/bin:/bin" HOME="${case_directory}/home" SHELL=/bin/sh \
    "${legacy_variable}=legacy" /bin/sh "${installer}" --help
  assert_contains "${case_directory}/output" \
    "legacy environment variable ${legacy_variable} is no longer supported; rename it to LEVIATHAN_${legacy_variable#MIGLENS_}"
done

# Latest release, default install directory, and Bash PATH guidance.
case_directory="${test_root}/latest"
mkdir -p "${case_directory}/home"
run_installer "${case_directory}/output" "${case_directory}/home" "${case_directory}/curl.log" "${release_directory}"
assert_contains "${case_directory}/home/.local/bin/leviathan" fixture-amd64
assert_contains "${case_directory}/curl.log" '/releases/latest/download/leviathan_linux_amd64.tar.gz'
assert_contains "${case_directory}/output" 'is not on PATH'
assert_contains "${case_directory}/output" '.bashrc'
assert_contains "${case_directory}/output" "printf '%s\\n' 'export PATH=\""
[[ ! -e "${case_directory}/home/.bashrc" ]] || fail "installer edited .bashrc"

# CLI flags override environment values, normalize versions, support arm64, and preserve spaces.
case_directory="${test_root}/pinned arm"
mkdir -p "${case_directory}/home"
env PATH="${fake_bin}:/usr/bin:/bin" HOME="${case_directory}/home" SHELL=/bin/zsh \
  FAKE_CURL_LOG="${case_directory}/curl.log" FAKE_RELEASE_DIR="${release_directory}" \
  FAKE_UNAME_S=Linux FAKE_UNAME_M=aarch64 FAKE_GLIBC_INFO='glibc 2.39' \
  LEVIATHAN_VERSION=9.9.9 LEVIATHAN_INSTALL_DIR="${case_directory}/wrong" \
  /bin/sh "${installer}" --version 0.3.0 --install-dir "${case_directory}/install path" \
  >"${case_directory}/output" 2>&1
assert_contains "${case_directory}/install path/leviathan" fixture-arm64
assert_contains "${case_directory}/curl.log" '/releases/download/v0.3.0/leviathan_linux_arm64.tar.gz'
assert_contains "${case_directory}/output" '.zshrc'
assert_contains "${case_directory}/output" "printf '%s\\n' 'export PATH=\""
[[ ! -e "${case_directory}/home/.zshrc" ]] || fail "installer edited .zshrc"
[[ ! -e "${case_directory}/wrong" ]] || fail "environment install directory overrode CLI"

# Environment variables provide defaults when no matching CLI flag is present.
case_directory="${test_root}/environment"
mkdir -p "${case_directory}/home"
env PATH="${fake_bin}:/usr/bin:/bin" HOME="${case_directory}/home" SHELL=/bin/sh \
  FAKE_CURL_LOG="${case_directory}/curl.log" FAKE_RELEASE_DIR="${release_directory}" \
  FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64 FAKE_GLIBC_INFO='glibc 2.34' \
  LEVIATHAN_VERSION=v0.3.0 LEVIATHAN_INSTALL_DIR="${case_directory}/install" \
  /bin/sh "${installer}" >"${case_directory}/output" 2>&1
assert_contains "${case_directory}/install/leviathan" fixture-amd64
assert_contains "${case_directory}/curl.log" '/releases/download/v0.3.0/leviathan_linux_amd64.tar.gz'

# No PATH warning when the effective install directory is already present.
case_directory="${test_root}/on-path"
install_directory="${case_directory}/bin"
mkdir -p "${case_directory}/home" "${install_directory}"
env -u LEVIATHAN_VERSION -u LEVIATHAN_INSTALL_DIR \
  PATH="${fake_bin}:${install_directory}:/usr/bin:/bin" \
  HOME="${case_directory}/home" SHELL=/bin/fish \
  FAKE_CURL_LOG="${case_directory}/curl.log" FAKE_RELEASE_DIR="${release_directory}" \
  FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64 FAKE_GLIBC_INFO='glibc 2.34' \
  /bin/sh "${installer}" --install-dir "${install_directory}" >"${case_directory}/output" 2>&1
assert_not_contains "${case_directory}/output" 'is not on PATH'

# A bad checksum is rejected before extraction or installation.
case_directory="${test_root}/bad-checksum"
mkdir -p "${case_directory}/home" "${case_directory}/release"
cp "${release_directory}"/* "${case_directory}/release/"
awk '$2 == "leviathan_linux_amd64.tar.gz" {$1 = "0000000000000000000000000000000000000000000000000000000000000000"} {print}' \
  "${case_directory}/release/checksums.txt" >"${case_directory}/release/checksums.tmp"
mv "${case_directory}/release/checksums.tmp" "${case_directory}/release/checksums.txt"
assert_failed "${case_directory}/output" run_installer \
  "${case_directory}/inner-output" "${case_directory}/home" "${case_directory}/curl.log" "${case_directory}/release" \
  --install-dir "${case_directory}/install"
assert_contains "${case_directory}/inner-output" 'checksum verification failed'
[[ ! -e "${case_directory}/install/leviathan" ]] || fail "bad checksum installed a binary"

# Platform, libc, HOME, and version failures happen before downloads.
for failure_case in old-glibc musl unsupported-os unsupported-arch missing-home invalid-version prerelease-version; do
  case_directory="${test_root}/${failure_case}"
  mkdir -p "${case_directory}/home"
  output="${case_directory}/output"
  log="${case_directory}/curl.log"
  case "${failure_case}" in
    old-glibc)
      assert_failed "${output}" env -u LEVIATHAN_VERSION -u LEVIATHAN_INSTALL_DIR PATH="${fake_bin}:/usr/bin:/bin" HOME="${case_directory}/home" SHELL=/bin/sh FAKE_CURL_LOG="${log}" FAKE_RELEASE_DIR="${release_directory}" FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64 FAKE_GLIBC_INFO='glibc 2.33' /bin/sh "${installer}" --install-dir "${case_directory}/install"
      assert_contains "${output}" 'requires glibc 2.34'
      ;;
    musl)
      assert_failed "${output}" env -u LEVIATHAN_VERSION -u LEVIATHAN_INSTALL_DIR PATH="${fake_bin}:/usr/bin:/bin" HOME="${case_directory}/home" SHELL=/bin/sh FAKE_CURL_LOG="${log}" FAKE_RELEASE_DIR="${release_directory}" FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64 FAKE_GLIBC_INFO='musl 1.2.5' /bin/sh "${installer}" --install-dir "${case_directory}/install"
      assert_contains "${output}" 'musl and unknown C libraries are unsupported'
      ;;
    unsupported-os)
      assert_failed "${output}" env -u LEVIATHAN_VERSION -u LEVIATHAN_INSTALL_DIR PATH="${fake_bin}:/usr/bin:/bin" HOME="${case_directory}/home" SHELL=/bin/sh FAKE_CURL_LOG="${log}" FAKE_RELEASE_DIR="${release_directory}" FAKE_UNAME_S=Darwin FAKE_UNAME_M=x86_64 FAKE_GLIBC_INFO='glibc 2.39' /bin/sh "${installer}" --install-dir "${case_directory}/install"
      assert_contains "${output}" 'Linux is required'
      ;;
    unsupported-arch)
      assert_failed "${output}" env -u LEVIATHAN_VERSION -u LEVIATHAN_INSTALL_DIR PATH="${fake_bin}:/usr/bin:/bin" HOME="${case_directory}/home" SHELL=/bin/sh FAKE_CURL_LOG="${log}" FAKE_RELEASE_DIR="${release_directory}" FAKE_UNAME_S=Linux FAKE_UNAME_M=riscv64 FAKE_GLIBC_INFO='glibc 2.39' /bin/sh "${installer}" --install-dir "${case_directory}/install"
      assert_contains "${output}" 'unsupported architecture'
      ;;
    missing-home)
      assert_failed "${output}" env -u HOME -u LEVIATHAN_VERSION -u LEVIATHAN_INSTALL_DIR PATH="${fake_bin}:/usr/bin:/bin" SHELL=/bin/sh FAKE_CURL_LOG="${log}" FAKE_RELEASE_DIR="${release_directory}" FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64 FAKE_GLIBC_INFO='glibc 2.39' /bin/sh "${installer}"
      assert_contains "${output}" 'HOME is unset'
      ;;
    invalid-version)
      assert_failed "${output}" env -u LEVIATHAN_VERSION -u LEVIATHAN_INSTALL_DIR PATH="${fake_bin}:/usr/bin:/bin" HOME="${case_directory}/home" SHELL=/bin/sh FAKE_CURL_LOG="${log}" FAKE_RELEASE_DIR="${release_directory}" FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64 FAKE_GLIBC_INFO='glibc 2.39' /bin/sh "${installer}" --version '../escape' --install-dir "${case_directory}/install"
      assert_contains "${output}" 'invalid version'
      ;;
    prerelease-version)
      assert_failed "${output}" env -u LEVIATHAN_VERSION -u LEVIATHAN_INSTALL_DIR PATH="${fake_bin}:/usr/bin:/bin" HOME="${case_directory}/home" SHELL=/bin/sh FAKE_CURL_LOG="${log}" FAKE_RELEASE_DIR="${release_directory}" FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64 FAKE_GLIBC_INFO='glibc 2.39' /bin/sh "${installer}" --version 'v0.3.0-rc.1' --install-dir "${case_directory}/install"
      assert_contains "${output}" 'invalid version'
      ;;
  esac
  [[ ! -s "${log}" ]] || fail "${failure_case} downloaded an asset"
done

# Rerunning atomically replaces the installed binary without leftover files.
case_directory="${test_root}/upgrade"
mkdir -p "${case_directory}/home" "${case_directory}/release"
cp "${release_directory}"/* "${case_directory}/release/"
run_installer "${case_directory}/first-output" "${case_directory}/home" "${case_directory}/first-curl.log" "${case_directory}/release" --install-dir "${case_directory}/install"
assert_contains "${case_directory}/install/leviathan" fixture-amd64
create_archive amd64 fixture-amd64-updated
cp "${release_directory}/leviathan_linux_amd64.tar.gz" "${case_directory}/release/"
(
  cd "${case_directory}/release"
  sha256sum leviathan_linux_amd64.tar.gz leviathan_linux_arm64.tar.gz >checksums.txt
)
run_installer "${case_directory}/second-output" "${case_directory}/home" "${case_directory}/second-curl.log" "${case_directory}/release" --install-dir "${case_directory}/install"
assert_contains "${case_directory}/install/leviathan" fixture-amd64-updated
[[ "$(find "${case_directory}/install" -maxdepth 1 -name '.leviathan.*' | wc -l)" -eq 0 ]] || fail "temporary install file remained"

# A managed symlink must survive even when its current target is absent.
case_directory="${test_root}/managed"
mkdir -p "${case_directory}/home" "${case_directory}/install"
ln -s /opt/leviathan/current/leviathan "${case_directory}/install/leviathan"
if run_installer "${case_directory}/output" "${case_directory}/home" "${case_directory}/curl.log" "${release_directory}" --install-dir "${case_directory}/install"; then
  fail "installer overwrote a managed symlink"
fi
assert_contains "${case_directory}/output" 'is managed by leviathan-updater'
[[ "$(readlink "${case_directory}/install/leviathan")" = /opt/leviathan/current/leviathan ]] || fail "managed symlink changed"
[[ ! -e "${case_directory}/curl.log" ]] || fail "managed target rejection downloaded assets"

echo "installer tests passed"
