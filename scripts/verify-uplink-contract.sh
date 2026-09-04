#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
lock_file="$repo_root/api/uplink-v1-contract.lock"
spec_file="$repo_root/api/uplink-v1-openapi.yaml"
golden_file="$repo_root/internal/uplink/testdata/uplink-v1.golden.json"
generated_file="$repo_root/internal/uplink/contract.gen.go"
directive_file="$repo_root/internal/uplink/generate.go"

lock_value() {
	sed -n "s/^$1=//p" "$lock_file"
}

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

expected_repository=$(lock_value canonical_repository)
expected_path=$(lock_value canonical_path)
contract_version=$(lock_value contract_version)
expected_spec=$(lock_value spec_sha256)
expected_golden=$(lock_value golden_sha256)
generator=$(lock_value generator)

if [ "$expected_repository" != "https://github.com/intellisys-stevens/yggdrasil" ] || \
	[ "$expected_path" != "api/uplink-v1-openapi.yaml" ] || \
	[ "$contract_version" != "1.0.0" ] || \
	[ "$generator" != "github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0" ]; then
	printf '%s\n' "vendored uplink contract provenance is invalid" >&2
	exit 1
fi
if ! grep -Fqx '//go:generate go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0 -generate types -package uplink -o contract.gen.go ../../api/uplink-v1-openapi.yaml' "$directive_file"; then
	printf '%s\n' "uplink Go generation directive is not pinned to the locked generator and vendored spec" >&2
	exit 1
fi
if [ "$(sha256_file "$spec_file")" != "$expected_spec" ]; then
	printf '%s\n' "vendored uplink OpenAPI checksum does not match api/uplink-v1-contract.lock" >&2
	exit 1
fi
if [ "$(sha256_file "$golden_file")" != "$expected_golden" ]; then
	printf '%s\n' "uplink golden payload checksum does not match api/uplink-v1-contract.lock" >&2
	exit 1
fi

generated_tmp=$(mktemp "${TMPDIR:-/tmp}/leviathan-uplink-contract.XXXXXX")
trap 'rm -f "$generated_tmp"' EXIT HUP INT TERM
(
	cd "$repo_root"
	go run "$generator" -generate types -package uplink -o "$generated_tmp" api/uplink-v1-openapi.yaml
)
if ! cmp -s "$generated_tmp" "$generated_file"; then
	printf '%s\n' "generated uplink DTOs are stale; run: go generate ./internal/uplink" >&2
	exit 1
fi

printf '%s\n' "uplink-v1 vendored contract verified"
