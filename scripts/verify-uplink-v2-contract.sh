#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"
lock=api/uplink-v2-contract.lock
hash() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}
expected() { awk -F= -v key="$1" '$1==key { print $2 }' "$lock"; }
[ "$(hash api/uplink-v2-openapi.yaml)" = "$(expected spec_sha256)" ] || { echo 'vendored uplink-v2 spec differs from its contract lock' >&2; exit 1; }
for name in uplink-v2.golden.json uplink-v2-amd.golden.json uplink-v2-cpu-only.golden.json; do
  [ "$(hash "internal/uplink/testdata/$name")" = "$(expected "$name")" ] || { echo "uplink-v2 fixture changed: $name" >&2; exit 1; }
done
go test ./internal/uplink -run 'TestV2ProjectionGoldenAndHardwareIndependentFixture|TestV2ClientSendsPortableEnvelopeAndChecksReceipt'
echo 'uplink-v2 vendored spec and independent projection verified'
