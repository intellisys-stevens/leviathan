#!/bin/sh
set -eu

repository="intellisys-stevens/miglens"
minimum_glibc="2.34"
requested_version=${MIGLENS_VERSION:-latest}
install_directory=${MIGLENS_INSTALL_DIR:-}
temporary_directory=
target_temporary=

usage() {
  cat <<'EOF'
Install MIGLens from a GitHub release.

Usage: install.sh [options]

Options:
  --version VERSION    Install a release such as v0.2.0 (default: latest)
  --install-dir DIR    Install directory (default: ~/.local/bin)
  -h, --help           Show this help

Environment:
  MIGLENS_VERSION       Default value for --version
  MIGLENS_INSTALL_DIR   Default value for --install-dir
EOF
}

fail() {
  printf 'miglens installer: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$target_temporary" ] && [ -e "$target_temporary" ]; then
    rm -f -- "$target_temporary"
  fi
  if [ -n "$temporary_directory" ] && [ -d "$temporary_directory" ]; then
    rm -rf -- "$temporary_directory"
  fi
}

trap cleanup 0
trap 'exit 1' HUP INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "--version requires a value"
      requested_version=$2
      shift 2
      ;;
    --version=*)
      requested_version=${1#*=}
      shift
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || fail "--install-dir requires a value"
      install_directory=$2
      shift 2
      ;;
    --install-dir=*)
      install_directory=${1#*=}
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      [ "$#" -eq 0 ] || fail "unexpected argument: $1"
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

for required_command in awk chmod cp curl find getconf grep mkdir mktemp mv sha256sum tar uname wc; do
  command -v "$required_command" >/dev/null 2>&1 || fail "required command not found: $required_command"
done

operating_system=$(uname -s)
[ "$operating_system" = "Linux" ] || fail "Linux is required (found $operating_system)"

machine=$(uname -m)
case "$machine" in
  x86_64 | amd64) architecture=amd64 ;;
  aarch64 | arm64) architecture=arm64 ;;
  *) fail "unsupported architecture: $machine" ;;
esac

glibc_description=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
case "$glibc_description" in
  glibc\ *) glibc_version=${glibc_description#glibc } ;;
  *) fail "MIGLens requires glibc $minimum_glibc or newer; musl and unknown C libraries are unsupported" ;;
esac

if ! awk -v have="$glibc_version" -v need="$minimum_glibc" 'BEGIN {
  split(have, h, "."); split(need, n, ".");
  for (i = 1; i <= 3; i++) {
    hv = h[i] + 0; nv = n[i] + 0;
    if (hv > nv) exit 0;
    if (hv < nv) exit 1;
  }
  exit 0;
}'; then
  fail "MIGLens requires glibc $minimum_glibc or newer (found $glibc_version)"
fi

if [ -z "$requested_version" ]; then
  requested_version=latest
fi

case "$requested_version" in
  latest)
    release_path="latest/download"
    display_version=latest
    ;;
  *)
    case "$requested_version" in
      v*) normalized_version=$requested_version ;;
      *) normalized_version="v$requested_version" ;;
    esac
    printf '%s\n' "$normalized_version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z][0-9A-Za-z.+-]*)?$' ||
      fail "invalid version: $requested_version"
    release_path="download/$normalized_version"
    display_version=$normalized_version
    ;;
esac

if [ -z "$install_directory" ]; then
  [ -n "${HOME:-}" ] || fail "HOME is unset; provide --install-dir"
  install_directory="$HOME/.local/bin"
fi

archive_name="miglens_linux_${architecture}.tar.gz"
base_url="https://github.com/${repository}/releases/${release_path}"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/miglens-install.XXXXXX")
archive_path="$temporary_directory/$archive_name"
checksums_path="$temporary_directory/checksums.txt"
extract_directory="$temporary_directory/extract"

curl --proto '=https' --tlsv1.2 --location --fail --silent --show-error \
  --output "$archive_path" "$base_url/$archive_name"
curl --proto '=https' --tlsv1.2 --location --fail --silent --show-error \
  --output "$checksums_path" "$base_url/checksums.txt"

expected_checksum=$(awk -v name="$archive_name" '
  $2 == name { value = $1; matches++ }
  END { if (matches == 1) print value; else exit 1 }
' "$checksums_path") || fail "checksums.txt does not contain exactly one entry for $archive_name"

printf '%s\n' "$expected_checksum" | grep -Eq '^[0-9a-fA-F]{64}$' || fail "invalid SHA-256 entry for $archive_name"
actual_checksum=$(sha256sum "$archive_path" | awk '{print $1}')
[ "$actual_checksum" = "$expected_checksum" ] || fail "checksum verification failed for $archive_name"

archive_entries=$(tar -tzf "$archive_path") || fail "cannot read $archive_name"
[ -n "$archive_entries" ] || fail "$archive_name is empty"
if ! printf '%s\n' "$archive_entries" | awk '
  /^\// { exit 1 }
  /(^|\/)\.\.(\/|$)/ { exit 1 }
'; then
  fail "$archive_name contains an unsafe path"
fi

mkdir -p "$extract_directory"
tar -xzf "$archive_path" -C "$extract_directory"
binary_paths=$(find "$extract_directory" -type f -name miglens -print)
binary_count=$(printf '%s\n' "$binary_paths" | awk 'NF { count++ } END { print count + 0 }')
[ "$binary_count" -eq 1 ] || fail "$archive_name must contain exactly one miglens binary"
binary_path=$binary_paths

mkdir -p "$install_directory"
install_directory=$(CDPATH=''; cd -P "$install_directory" && pwd)
target_path="$install_directory/miglens"
target_temporary=$(mktemp "$install_directory/.miglens.XXXXXX")
cp "$binary_path" "$target_temporary"
chmod 0755 "$target_temporary"
mv -f "$target_temporary" "$target_path"
target_temporary=

printf 'Installed MIGLens %s to %s\n' "$display_version" "$target_path"

case ":${PATH:-}:" in
  *":$install_directory:"*) ;;
  *)
    printf '\n%s is not on PATH. For this shell, run:\n' "$install_directory"
    printf '  export PATH="%s:%s"\n' "$install_directory" "\$PATH"
    shell_name=${SHELL##*/}
    case "$shell_name" in
      bash)
        printf 'For future Bash sessions, run:\n'
        printf "  printf '%%s\\\\n' 'export PATH=\"%s:\$PATH\"' >> ~/.bashrc\n" "$install_directory"
        ;;
      zsh)
        printf 'For future Zsh sessions, run:\n'
        printf "  printf '%%s\\\\n' 'export PATH=\"%s:\$PATH\"' >> ~/.zshrc\n" "$install_directory"
        ;;
      fish)
        printf 'For future Fish sessions, run:\n'
        printf '  fish_add_path "%s"\n' "$install_directory"
        ;;
      *)
        printf 'Add the export line to your shell profile for future sessions.\n'
        ;;
    esac
    ;;
esac
