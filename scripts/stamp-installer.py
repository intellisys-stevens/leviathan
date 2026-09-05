#!/usr/bin/env python3
"""Generate the release-specific installer after both native archives exist."""

import argparse
import hashlib
from pathlib import Path
import re
import sys

START = "# BEGIN RELEASE INSTALLER PINS\n"
END = "# END RELEASE INSTALLER PINS\n"
FIELDS = ("release_version", "release_commit", "release_amd64_archive_sha256", "release_arm64_archive_sha256", "release_amd64_updater_sha256", "release_arm64_updater_sha256")


def stamp(source, directory, version, commit):
    version = version.removeprefix("v")
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("installer requires an exact stable version and full source commit")
    pins = {"release_version": version, "release_commit": commit}
    for kind, name in (("archive", "leviathan_linux_{arch}.tar.gz"), ("updater", "leviathan-updater_linux_{arch}")):
        for arch in ("amd64", "arm64"):
            path = directory / name.format(arch=arch)
            if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
                raise ValueError("both immutable native archives and updater helpers are required")
            with path.open("rb") as stream:
                pins[f"release_{arch}_{kind}_sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
    if source.count(START) != 1 or source.count(END) != 1:
        raise ValueError("installer template must have exactly one release pin block")
    before, tail = source.split(START)
    _, after = tail.split(END)
    return before + START + "".join(f"{field}='{pins[field]}'\n" for field in FIELDS) + END + after


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--directory", type=Path, default=Path("dist"))
    parser.add_argument("--source", type=Path, default=Path(__file__).with_name("install.sh"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        output = args.output or args.directory / "install.sh"
        if output.resolve() == args.source.resolve():
            raise ValueError("release stamping must not overwrite its source template")
        output.write_text(stamp(args.source.read_text(), args.directory, args.version, args.commit))
        output.chmod(0o755)
    except (OSError, ValueError) as error:
        print("installer generation: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
