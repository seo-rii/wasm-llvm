#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/probe-dmd-wasi-frontend.sh --ldc-source DIR --bootstrap-ldmd2 PATH [--out DIR] [--apply-patches]

Compiles every DMD frontend D source in an LDC checkout to wasm32-wasi object files.
This is a porting probe for the browser/WASI-hosted compiler, not the final ldc2.wasm link.

Environment:
  LDC_SOURCE_DIR        Default for --ldc-source.
  LDC_BOOTSTRAP_LDMD2   Default for --bootstrap-ldmd2.
  LDC_WASM_PROBE_OUT    Default output directory.
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ldc_source_dir="${LDC_SOURCE_DIR:-${repo_root}/build/ldc-src}"
bootstrap_ldmd2="${LDC_BOOTSTRAP_LDMD2:-}"
out_dir="${LDC_WASM_PROBE_OUT:-${repo_root}/build/probe-dmd-wasi-objects}"
apply_patches=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --ldc-source)
      [[ $# -ge 2 ]] || { echo "error: --ldc-source requires a value" >&2; exit 2; }
      ldc_source_dir="$2"
      shift 2
      ;;
    --bootstrap-ldmd2)
      [[ $# -ge 2 ]] || { echo "error: --bootstrap-ldmd2 requires a value" >&2; exit 2; }
      bootstrap_ldmd2="$2"
      shift 2
      ;;
    --out)
      [[ $# -ge 2 ]] || { echo "error: --out requires a value" >&2; exit 2; }
      out_dir="$2"
      shift 2
      ;;
    --apply-patches)
      apply_patches=1
      shift
      ;;
    *)
      echo "error: unexpected argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "${ldc_source_dir}/dmd" ]]; then
  echo "error: --ldc-source must point to an LDC checkout: ${ldc_source_dir}" >&2
  exit 1
fi

if [[ -z "${bootstrap_ldmd2}" || ! -x "${bootstrap_ldmd2}" ]]; then
  echo "error: --bootstrap-ldmd2 must point to an executable ldmd2" >&2
  exit 1
fi

if [[ ${apply_patches} -eq 1 ]]; then
  "${repo_root}/scripts/apply-ldc-patches.sh" "${ldc_source_dir}"
fi

rm -rf "${out_dir}"
mkdir -p "${out_dir}"

mapfile -t dmd_sources < <(find "${ldc_source_dir}/dmd" -type f -name '*.d' | sort)
if [[ ${#dmd_sources[@]} -eq 0 ]]; then
  echo "error: no DMD frontend D sources found under ${ldc_source_dir}/dmd" >&2
  exit 1
fi

"${bootstrap_ldmd2}" \
  -c -oq -mtriple=wasm32-wasi -wi -version=IN_LLVM \
  -I"${ldc_source_dir}" \
  -I"${ldc_source_dir}/runtime/druntime/src" \
  -I"${ldc_source_dir}/runtime/phobos" \
  -J"${ldc_source_dir}/dmd/res" \
  "${dmd_sources[@]}" \
  -od="${out_dir}"

object_count="$(find "${out_dir}" -type f -name '*.o' | wc -l | tr -d ' ')"
echo "compiled ${#dmd_sources[@]} DMD frontend source(s) to ${object_count} wasm32-wasi object(s)"
