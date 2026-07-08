#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$repo_root/.github/extensions/drawio/assets-manifest.json"
src="$repo_root/.github/extensions/drawio/drawio-webapp"
out_dir="${1:-$repo_root/dist}"

if [[ ! -f "$manifest" ]]; then
	echo "Asset manifest not found at $manifest" >&2
	exit 1
fi

if [[ ! -d "$src" ]]; then
	echo "draw.io webapp assets not found at $src" >&2
	echo "Run: git submodule update --init --recursive && ./scripts/sync-drawio-webapp.sh" >&2
	exit 1
fi

version="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version)" "$manifest")"
archive_name="drawio-webapp-${version}.tar.gz"
archive_path="$out_dir/$archive_name"

mkdir -p "$out_dir"
rm -f "$archive_path"

python3 - "$src" "$archive_path" <<'PY'
import gzip
import os
import stat
import sys
import tarfile

src, archive_path = sys.argv[1], sys.argv[2]

with open(archive_path, "wb") as raw:
    with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
            directories = set()
            files = []
            for root, dirnames, filenames in os.walk(src):
                dirnames.sort()
                filenames.sort()
                rel_root = os.path.relpath(root, src)
                if rel_root != ".":
                    directories.add(rel_root)
                for filename in filenames:
                    files.append(os.path.join(rel_root, filename) if rel_root != "." else filename)

            for rel in sorted(directories):
                info = tarfile.TarInfo("drawio-webapp/" + rel)
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = 0
                tar.addfile(info)

            for rel in sorted(files):
                full_path = os.path.join(src, rel)
                info = tar.gettarinfo(full_path, "drawio-webapp/" + rel)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = 0
                info.mode = 0o755 if info.mode & stat.S_IXUSR else 0o644
                with open(full_path, "rb") as file:
                    tar.addfile(info, file)
PY

sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
size="$(wc -c < "$archive_path" | tr -d ' ')"

printf 'Archive: %s\n' "$archive_path"
printf 'SHA-256: %s\n' "$sha256"
printf 'Size: %s bytes\n' "$size"
