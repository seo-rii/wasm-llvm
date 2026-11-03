#!/usr/bin/env bash
# Build only the qualified official GCC arc-counter runtime for WASI.
set -euo pipefail
recipe=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=${GCC_WASI_WORK_DIR:?Set GCC_WASI_WORK_DIR}
sdk=${WASI_SDK_PATH:?Set WASI_SDK_PATH to the pinned wasi-sdk-33}
sysroot=${GCC_WASI_SYSROOT:-$work/runtime-current/sysroot}
output=${GCC_LIBGCOV_WORK_DIR:-$work/libgcov-current}
exec python3 "$recipe/build-libgcov.py" --work "$work" --sdk "$sdk" --sysroot "$sysroot" --output "$output"
