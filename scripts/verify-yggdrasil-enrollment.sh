#!/bin/sh
# Build the real agent and exercise enrollment, renewal, and uplink against
# Yggdrasil's central receiver. All processes and state stay in the container.
set -eu
repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
yggdrasil_root=$(CDPATH='' cd -- "${1:-$repo_root/../yggdrasil}" && pwd)
output=$(mktemp -d "${TMPDIR:-/tmp}/leviathan-enrollment.XXXXXX")
trap 'rm -rf "$output"' EXIT HUP INT TERM
module_cache=$(go env GOMODCACHE)
docker run --rm \
  -e GOTOOLCHAIN=local -e GOCACHE=/out/cache -e CGO_CFLAGS=-Wno-deprecated-declarations \
  -v "$repo_root:/leviathan:ro" -v "$yggdrasil_root:/yggdrasil:ro" \
  -v "$module_cache:/go/pkg/mod" -v "$output:/out" \
  -w /leviathan golang:1.27.1-bookworm sh -c '
    go test ./internal/cli ./internal/uplink ./internal/config &&
    go build -o /out/leviathan ./cmd/leviathan &&
    cd /yggdrasil &&
    LEVIATHAN_BINARY=/out/leviathan go test ./internal/agentregistry -run TestLeviathanBinaryJoinAndUplink -count=1 -v
  '
