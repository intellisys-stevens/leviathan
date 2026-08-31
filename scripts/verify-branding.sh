#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

legacy_name='mig'
legacy_name+='lens'
match_file=$(mktemp)
trap 'rm -f -- "$match_file"' EXIT

allowed_legacy_file() {
  case "$1" in
    LICENSE | NOTICE | docs/migration-v0.3.md | docs/releasing.md | \
      internal/cli/root_test.go | internal/config/config.go | \
      internal/config/config_test.go | scripts/install.sh | \
      scripts/install_test.sh | scripts/verify-branding.sh | \
      scripts/verify-release-archive.sh | web/e2e/dashboard.spec.ts | \
      web/src/App.test.tsx | web/src/branding.test.ts)
      return 0
      ;;
    *) return 1 ;;
  esac
}

failure=0
while IFS= read -r -d '' file; do
  [[ -f "$file" ]] || continue
  if allowed_legacy_file "$file"; then
    continue
  fi
  if LC_ALL=C grep -Iq -i -- "$legacy_name" "$file" 2>/dev/null; then
    LC_ALL=C grep -In -i -o -m 5 -- "$legacy_name" "$file" >"$match_file"
    printf 'legacy product name remains in %s:\n' "$file" >&2
    sed 's/^/  /' "$match_file" >&2
    failure=1
  fi
done < <(git ls-files -z --cached --others --exclude-standard)

legacy_path_failure=0
while IFS= read -r -d '' file; do
  [[ -e "$file" ]] || continue
  if grep -Eqi "(^|/)${legacy_name}([@._/-]|$)" <<<"$file"; then
    printf 'legacy-named path remains: %s\n' "$file" >&2
    legacy_path_failure=1
  fi
done < <(git ls-files -z --cached --others --exclude-standard)
if ((legacy_path_failure != 0)); then
  failure=1
fi

if ((failure != 0)); then
  exit 1
fi

grep -F 'Leviathan (formerly MIGLens)' NOTICE >/dev/null
grep -F 'Copyright (c) 2026 MIGLens contributors' LICENSE >/dev/null
grep -F 'MIGLENS_' internal/config/config.go >/dev/null
grep -F 'MIGLENS_' scripts/install.sh >/dev/null
grep -F 'A saved v0.2.1' docs/migration-v0.3.md >/dev/null

printf 'verified clean Leviathan branding and explicit migration allowlist\n'
