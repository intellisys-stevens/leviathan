#!/usr/bin/env python3
"""Embed the trusted managed installer so install.sh needs no unsigned helper."""

import argparse
from pathlib import Path
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
root = Path(__file__).resolve().parent
installer = root / "install.sh"
start = "# BEGIN EMBEDDED MANAGED INSTALLER\n"
end = "# END EMBEDDED MANAGED INSTALLER\n"
source = (root / "install-managed.py").read_text()
block = start + '''for installer_argument in "$@"; do
  if [ "$installer_argument" = "--with-updater" ]; then
    command -v python3 >/dev/null 2>&1 || fail "--with-updater requires Python 3.11 or newer"
    python3 -I - "$@" <<'LEVIATHAN_MANAGED_INSTALLER_PYTHON'
''' + source + '''LEVIATHAN_MANAGED_INSTALLER_PYTHON
    exit $?
  fi
done
''' + end
current = installer.read_text()
if start in current and end in current:
    before, rest = current.split(start, 1)
    _, after = rest.split(end, 1)
else:
    before, after = current.split("cleanup() {", 1)
    after = "\ncleanup() {" + after
updated = before + block + after
if args.check:
    if updated != current:
        print("install.sh managed verifier is stale; run scripts/sync-managed-installer.py", file=sys.stderr)
        sys.exit(1)
else:
    installer.write_text(updated)
