#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/apply-ldc-patches.sh [LDC_SOURCE_DIR]

Applies ldc-wasm's LDC and Phobos source patches to a checkout of ldc-developers/ldc.

Environment:
  LDC_SOURCE_DIR  Default source directory when no argument is supplied.
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ldc_source_dir="${LDC_SOURCE_DIR:-${repo_root}/build/ldc-src}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi

if [[ $# -eq 1 ]]; then
  ldc_source_dir="$1"
fi

if [[ ! -e "${ldc_source_dir}/.git" ]]; then
  echo "error: LDC_SOURCE_DIR is not a git checkout: ${ldc_source_dir}" >&2
  exit 1
fi

apply_patch_dir() {
  local target_dir="$1"
  local patch_dir="$2"
  local label="$3"

  shopt -s nullglob
  local patches=("${patch_dir}"/*.patch)
  shopt -u nullglob

  if [[ ${#patches[@]} -eq 0 ]]; then
    echo "error: no ${label} patches found under ${patch_dir}" >&2
    exit 1
  fi

  for patch in "${patches[@]}"; do
    local patch_name
    patch_name="$(basename "${patch}")"
    if git -C "${target_dir}" apply --reverse --check "${patch}" >/dev/null 2>&1; then
      echo "already applied ${label}: ${patch_name}"
      continue
    fi
    git -C "${target_dir}" apply --check "${patch}"
    git -C "${target_dir}" apply "${patch}"
    echo "applied ${label}: ${patch_name}"
  done
}

apply_patch_dir "${ldc_source_dir}" "${repo_root}/patches/ldc-1.42.0" "ldc"

phobos_patch_dir="${repo_root}/patches/phobos-ldc-1.42.0"
if [[ -d "${phobos_patch_dir}" ]]; then
  phobos_source_dir="${ldc_source_dir}/runtime/phobos"
  if [[ ! -e "${phobos_source_dir}/.git" ]]; then
    echo "error: Phobos submodule checkout not found: ${phobos_source_dir}" >&2
    exit 1
  fi
  apply_patch_dir "${phobos_source_dir}" "${phobos_patch_dir}" "phobos"
fi
