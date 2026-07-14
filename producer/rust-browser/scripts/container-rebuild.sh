#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCER_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PRODUCER_ROOT/../.." && pwd)"
WORK_DIR="${1:-}"

if [[ -z "$WORK_DIR" ]]; then
  printf 'usage: %s /path/to/new-empty-work-directory\n' "$0" >&2
  exit 2
fi

mkdir -p "$WORK_DIR"
WORK_DIR="$(cd "$WORK_DIR" && pwd)"
if [[ -n "$(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  printf 'container rebuild work directory must be empty: %s\n' "$WORK_DIR" >&2
  exit 2
fi

manifest_sha="$({ sha256sum "$PRODUCER_ROOT/manifest.json" || shasum -a 256 "$PRODUCER_ROOT/manifest.json"; } | awk '{print $1}')"
image_tag="wasm-llvm-rust-browser:${manifest_sha:0:16}"

docker build \
  --platform linux/amd64 \
  --file "$PRODUCER_ROOT/Containerfile" \
  --tag "$image_tag" \
  "$PRODUCER_ROOT"

docker run --rm \
  --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  --env HOME=/work/home \
  --env NINJA_JOBS="${NINJA_JOBS:-8}" \
  --env WASM_LLVM_RUST_BROWSER_WORK_DIR=/work \
  --mount "type=bind,src=$REPO_ROOT,dst=/src,readonly" \
  --mount "type=bind,src=$WORK_DIR,dst=/work" \
  "$image_tag"
