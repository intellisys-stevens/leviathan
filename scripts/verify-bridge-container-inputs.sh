#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
packages=$(mktemp)
trap 'rm -f -- "$packages"' EXIT
go list -deps -f '{{if not .Standard}}{{.Dir}}{{end}}' ./cmd/leviathan-kubernetes-bridge >"$packages"
python3 - "$repo_root" "$packages" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
dockerfile = root / 'contrib/container/leviathan-kubernetes-bridge.Dockerfile'
copied = []
for line in dockerfile.read_text().splitlines():
    fields = line.split()
    if not fields or fields[0] != 'COPY' or fields[1].startswith('--'):
        continue
    for source in fields[1:-1]:
        path = root / source
        copied.append(path.parent if '*' in source else path)

missing = []
for package in pathlib.Path(sys.argv[2]).read_text().splitlines():
    if not package:
        continue
    path = pathlib.Path(package).resolve()
    if path.is_relative_to(root) and not any(path == parent or path.is_relative_to(parent) for parent in copied):
        missing.append(str(path.relative_to(root)))
if missing:
    raise SystemExit('Bridge image omits imported packages: ' + ', '.join(sorted(missing)))
print('verified bridge container covers every local imported package')
PY
