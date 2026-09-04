#!/bin/sh
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
canonical_root=${1:-${YGGDRASIL_CHECKOUT:-}}
if [ -z "$canonical_root" ]; then
	printf '%s\n' "usage: scripts/sync-uplink-contract.sh /path/to/yggdrasil" >&2
	exit 2
fi
canonical_root=$(CDPATH='' cd -- "$canonical_root" && pwd)
source_spec="$canonical_root/api/uplink-v1-openapi.yaml"
source_lock="$canonical_root/api/uplink-v1-contract.lock"

if [ ! -f "$source_spec" ] || [ ! -f "$source_lock" ]; then
	printf '%s\n' "the selected Yggdrasil checkout does not contain the canonical uplink-v1 contract" >&2
	exit 1
fi

lock_value() {
	sed -n "s/^$1=//p" "$source_lock"
}

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

if [ "$(lock_value canonical_repository)" != "https://github.com/intellisys-stevens/yggdrasil" ] || \
	[ "$(lock_value canonical_path)" != "api/uplink-v1-openapi.yaml" ] || \
	[ "$(lock_value contract_version)" != "1.0.0" ] || \
	[ "$(lock_value generator)" != "github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0" ] || \
	[ "$(sha256_file "$source_spec")" != "$(lock_value spec_sha256)" ]; then
	printf '%s\n' "the selected canonical contract failed provenance or checksum validation" >&2
	exit 1
fi

install -m 0644 "$source_spec" "$repo_root/api/uplink-v1-openapi.yaml"
install -m 0644 "$source_lock" "$repo_root/api/uplink-v1-contract.lock"
(
	cd "$repo_root"
	go generate ./internal/uplink
)
"$repo_root/scripts/verify-uplink-contract.sh"
