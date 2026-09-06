#!/bin/sh
set -eu
repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
python3 - "$repo_root" "${1:-}" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);peer=pathlib.Path(sys.argv[2]) if sys.argv[2] else None
lock=json.loads((root/'api/agent-updates-v1-contract.lock.json').read_text())
assert lock['canonicalRepository']=='https://github.com/intellisys-stevens/yggdrasil'
assert lock['contractVersion']=='1.0.0'
for name,digest in lock['files'].items():
    data=(root/name).read_bytes()
    assert hashlib.sha256(data).hexdigest()==digest, f'Update contract drift: {name}'
    if peer: assert (peer/name).read_bytes()==data, f'Cross-repository contract mismatch: {name}'
print('Update contract lock verified'+ (' against peer repository' if peer else ''))
PY
if [ -d "$repo_root/internal/updateprotocol/cmd/contractgen" ]; then
  temporary=$(mktemp -d "${TMPDIR:-/tmp}/update-contract.XXXXXX")
  trap 'rm -rf "$temporary"' EXIT HUP INT TERM
  (cd "$repo_root" && go run ./internal/updateprotocol/cmd/contractgen "$temporary")
  cmp "$temporary/api/agent-updates-v1-openapi.json" "$repo_root/api/agent-updates-v1-openapi.json"
  cmp "$temporary/internal/updateprotocol/testdata/release-v1.golden.json" "$repo_root/internal/updateprotocol/testdata/release-v1.golden.json"
fi
(cd "$repo_root" && go test ./internal/updateprotocol)
