#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo_root/drawio/src/main/webapp"
dst="$repo_root/.github/extensions/drawio/drawio-webapp"

if [[ ! -d "$src" ]]; then
	echo "draw.io submodule webapp not found at $src" >&2
	echo "Run: git submodule update --init --recursive" >&2
	exit 1
fi

rm -rf "$dst"
mkdir -p "$dst"

rsync -a --delete --prune-empty-dirs \
	--include='/index.html' \
	--include='/js/***' \
	--include='/connect/***' \
	--include='/images/***' \
	--include='/img/***' \
	--include='/math/***' \
	--include='/mxgraph/***' \
	--include='/plugins/***' \
	--include='/resources/***' \
	--include='/styles/***' \
	--include='/templates/***' \
	--include='*/' \
	--exclude='*' \
	"$src/" "$dst/"

du -sh "$dst"
