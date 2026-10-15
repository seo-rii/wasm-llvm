#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/write-llvm-config-wasi-wrapper.sh --llvm-build DIR --llvm-source DIR --out PATH

Writes a host-executable llvm-config wrapper for a wasm32-wasi LLVM build tree.
The wrapper reports the WASI build's include and static-library paths so LDC's
legacy FindLLVM.cmake can configure a WASI-hosted ldc2 build.
EOF
}

llvm_build_dir=""
llvm_source_dir=""
out_path=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --llvm-build)
      [[ $# -ge 2 ]] || { echo "error: --llvm-build requires a value" >&2; exit 2; }
      llvm_build_dir="$2"
      shift 2
      ;;
    --llvm-source)
      [[ $# -ge 2 ]] || { echo "error: --llvm-source requires a value" >&2; exit 2; }
      llvm_source_dir="$2"
      shift 2
      ;;
    --out)
      [[ $# -ge 2 ]] || { echo "error: --out requires a value" >&2; exit 2; }
      out_path="$2"
      shift 2
      ;;
    *)
      echo "error: unexpected argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${llvm_build_dir}" || -z "${llvm_source_dir}" || -z "${out_path}" ]]; then
  usage >&2
  exit 2
fi

llvm_build_dir="$(cd "${llvm_build_dir}" && pwd)"
llvm_source_dir="$(cd "${llvm_source_dir}" && pwd)"
llvm_config_cmake="${llvm_build_dir}/lib/cmake/llvm/LLVMConfig.cmake"
llvm_lib_dir="${llvm_build_dir}/lib"

if [[ ! -f "${llvm_config_cmake}" ]]; then
  echo "error: LLVMConfig.cmake not found under ${llvm_build_dir}/lib/cmake/llvm" >&2
  exit 1
fi

if [[ ! -d "${llvm_source_dir}/include/llvm" ]]; then
  echo "error: --llvm-source must point to an LLVM source tree: ${llvm_source_dir}" >&2
  exit 1
fi

required_libs=(
  LLVMWindowsManifest
  LLVMWindowsDriver
  LLVMTableGen
  LLVMLTO
  LLVMPasses
  LLVMIRPrinter
  LLVMCoroutines
  LLVMExtensions
  LLVMLibDriver
  LLVMOption
  LLVMipo
  LLVMInstrumentation
  LLVMVectorize
  LLVMLinker
  LLVMFrontendOpenMP
  LLVMWebAssemblyDisassembler
  LLVMMCDisassembler
  LLVMWebAssemblyAsmParser
  LLVMWebAssemblyCodeGen
  LLVMWebAssemblyDesc
  LLVMWebAssemblyUtils
  LLVMWebAssemblyInfo
  LLVMGlobalISel
  LLVMSelectionDAG
  LLVMAsmPrinter
  LLVMCodeGen
  LLVMTarget
  LLVMScalarOpts
  LLVMInstCombine
  LLVMAggressiveInstCombine
  LLVMObjCARCOpts
  LLVMTransformUtils
  LLVMBitWriter
  LLVMAnalysis
  LLVMProfileData
  LLVMSymbolize
  LLVMDebugInfoPDB
  LLVMDebugInfoMSF
  LLVMDebugInfoDWARF
  LLVMObject
  LLVMTextAPI
  LLVMMCParser
  LLVMIRReader
  LLVMAsmParser
  LLVMMC
  LLVMDebugInfoCodeView
  LLVMBitReader
  LLVMCore
  LLVMRemarks
  LLVMBitstreamReader
  LLVMBinaryFormat
  LLVMTargetParser
  LLVMSupport
  LLVMDemangle
)

for lib in "${required_libs[@]}"; do
  if [[ ! -f "${llvm_lib_dir}/lib${lib}.a" ]]; then
    echo "error: required LLVM WASI static library is missing: ${llvm_lib_dir}/lib${lib}.a" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "${out_path}")"

{
  printf '#!/usr/bin/env bash\n'
  printf 'set -euo pipefail\n\n'
  printf 'llvm_build_dir=%q\n' "${llvm_build_dir}"
  printf 'llvm_source_dir=%q\n' "${llvm_source_dir}"
  printf 'llvm_lib_dir="${llvm_build_dir}/lib"\n'
  printf 'llvm_cmake_dir="${llvm_build_dir}/lib/cmake/llvm"\n\n'
  printf 'libs=(\n'
  for lib in "${required_libs[@]}"; do
    printf '  -l%s\n' "${lib}"
  done
  printf ')\n\n'
  cat <<'EOF'
args=()
for arg in "$@"; do
  case "${arg}" in
    --link-static|--link-shared)
      ;;
    *)
      args+=("${arg}")
      ;;
  esac
done

if [[ ${#args[@]} -eq 0 ]]; then
  echo "error: missing llvm-config option" >&2
  exit 1
fi

case "${args[0]}" in
  --version)
    echo "16.0.6"
    ;;
  --shared-mode)
    echo "static"
    ;;
  --assertion-mode)
    echo "OFF"
    ;;
  --host-target)
    echo "wasm32-wasi"
    ;;
  --targets-built)
    echo "WebAssembly"
    ;;
  --prefix)
    echo "${llvm_build_dir}"
    ;;
  --includedir)
    echo "${llvm_source_dir}/include"
    ;;
  --libdir)
    echo "${llvm_lib_dir}"
    ;;
  --cmakedir)
    echo "${llvm_cmake_dir}"
    ;;
  --cxxflags)
    echo "-I${llvm_source_dir}/include -I${llvm_build_dir}/include -std=c++17 -fno-exceptions -fno-rtti -D_GNU_SOURCE -D__STDC_CONSTANT_MACROS -D__STDC_FORMAT_MACROS -D__STDC_LIMIT_MACROS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID"
    ;;
  --ldflags)
    echo "-L${llvm_lib_dir}"
    ;;
  --system-libs)
    echo "-lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid"
    ;;
  --libs)
    printf '%s\n' "${libs[*]}"
    ;;
  *)
    echo "error: unsupported llvm-config option for WASI wrapper: ${args[0]}" >&2
    exit 1
    ;;
esac
EOF
} >"${out_path}"

chmod +x "${out_path}"
echo "wrote ${out_path}"
