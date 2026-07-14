#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s EMPTY_WORK_DIRECTORY\n' "$0" >&2
  exit 2
fi

work_dir="$(realpath -m "$1")"
if [[ -e "$work_dir" ]]; then
  if [[ ! -d "$work_dir" || -n "$(find "$work_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    printf 'clean rebuild directory must not exist or must be empty: %s\n' "$work_dir" >&2
    exit 2
  fi
fi

mkdir -p "$work_dir"
WASM_LLVM_RUST_BROWSER_WORK_DIR="$work_dir" \
  exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/build.sh"
