#!/usr/bin/env bash
# Canadian cross: Linux build tools -> Emscripten host -> GNU/Linux x86-64 target.
# Adapted from the pinned AVR/ARM precedents in sources.lock.json. Their success
# does not establish x86-64 support; qualification must run the resulting modules.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=${GCC_WASM_WORK_DIR:?Set GCC_WASM_WORK_DIR to an isolated build directory}
output=${GCC_WASM_OUT_DIR:?Set GCC_WASM_OUT_DIR to a new compiler output directory}
jobs=${GCC_WASM_JOBS:-2}
[[ $jobs =~ ^[1-9][0-9]*$ ]] || { echo 'GCC_WASM_JOBS must be positive' >&2; exit 2; }
mkdir -p "$work"
work=$(realpath "$work")
[[ ! -e $output ]] || { echo "Output already exists: $output" >&2; exit 2; }
output=$(realpath -m "$output")
case "$output/" in "$work/sources/"*|"$work/emsdk/"*|"$work/build/"*) echo 'Output overlaps build inputs' >&2; exit 2;; esac
for tool in python3 node make gcc-13 g++-13 bison flex git curl xz; do command -v "$tool" >/dev/null; done
[[ $(g++-13 -dumpfullversion) == 13.3.0 ]] || { echo 'Native GCC 13.3.0 required to match the GNU target headers/runtime' >&2; exit 2; }
python3 "$script_dir/build-support.py" --work "$work" --minimum-free-gib "${GCC_WASM_MIN_FREE_GIB:-16}"
# emsdk_env.sh is part of the revision-verified SDK, not untrusted shell output.
# shellcheck disable=SC1091
source "$work/emsdk/emsdk_env.sh"
export EM_CACHE="$work/emscripten-cache" EM_PORTS="$work/emscripten-ports"
[[ $(emcc --version | head -1) == *'4.0.23'* ]] || { echo 'Unexpected Emscripten version' >&2; exit 2; }
source_root="$work/sources"
gcc_source="$source_root/gcc-13.3.0"
binutils_source="$source_root/binutils-2.42"
build_triple=$("$gcc_source/config.guess")
target=x86_64-linux-gnu
host=wasm32-unknown-emscripten
wasmdeps="$work/host-libraries"
mkdir -p "$work/build" "$wasmdeps" "$output"

# These programs execute while building, so they MUST remain native. The host
# libraries, compiler objects and assembler/linker objects use emcc/em++ instead.
export CC_FOR_BUILD=gcc-13 CXX_FOR_BUILD=g++-13 HOST_CC=gcc-13 HOST_CXX=g++-13 BUILD_CC=gcc-13
export CFLAGS_FOR_BUILD='-O2' CXXFLAGS_FOR_BUILD='-O2'
export CONFIG_SITE="$work/emscripten.config.site"
printf 'am_cv_ar_has_plugin=no\nam_cv_ranlib_has_plugin=no\n' > "$CONFIG_SITE"
hostflags='-Os -g0 -DHAVE_PSIGNAL=1 -DELIDE_CODE'
# FS and callMain implement the explicit Worker pipeline. No gcc/g++ driver is
# shipped: fork/exec/collect2 are not a browser process API. No source rewriting.
moduleflags='-Os -g0 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createModule -sENVIRONMENT=worker,node -sINVOKE_RUN=0 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=128MB -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=16MB -sUSE_ZLIB=1'

for component in gmp-6.3.0 mpfr-4.2.1 mpc-1.3.1; do
  build="$work/build/$component"
  mkdir -p "$build"
  cd "$build"
  extra=()
  case "$component" in
    gmp-*) extra+=(--disable-assembly);;
    mpfr-*) extra+=(--with-gmp="$wasmdeps");;
    mpc-*) extra+=(--with-gmp="$wasmdeps" --with-mpfr="$wasmdeps");;
  esac
  if [[ ! -f Makefile ]]; then
    emconfigure "$source_root/$component/configure" --build="$build_triple" --host="$host" \
      --prefix="$wasmdeps" --disable-shared --enable-static "${extra[@]}" \
      CC_FOR_BUILD=gcc-13 CFLAGS="$hostflags"
  fi
  emmake make -j"$jobs"
  emmake make install
 done

build="$work/build/binutils"
mkdir -p "$build"
cd "$build"
if [[ ! -f Makefile ]]; then
  emconfigure "$binutils_source/configure" --build="$build_triple" --host="$host" --target="$target" \
    --prefix=/opt/gcc-wasm --with-sysroot=/sysroot --enable-64-bit-bfd \
    --enable-ld=default --disable-gold --disable-gdb --disable-gdbserver --disable-sim \
    --disable-nls --disable-werror --disable-gprof --disable-gprofng --disable-plugins \
    --disable-shared --disable-debuginfod --without-zstd \
    CC_FOR_BUILD=gcc-13 CXX_FOR_BUILD=g++-13 CFLAGS="$hostflags" CXXFLAGS="$hostflags" \
    LDFLAGS="$moduleflags" MAKEINFO=true
fi
# BFD headers must exist before GAS/LD compile. Avoid unsupported auxiliary
# tools instead of accepting a failed all-binutils as a successful compiler.
emmake make -j"$jobs" all-libiberty all-bfd all-opcodes all-libsframe MAKEINFO=true
emmake make -j"$jobs" all-gas all-ld MAKEINFO=true
for pair in gas/as-new:as ld/ld-new:ld; do
  tool_path=${pair%%:*}
  tool_name=${pair##*:}
  install -m644 "$build/$tool_path" "$output/$tool_name.mjs"
  install -m644 "$build/$tool_path.wasm" "$output/$tool_name.wasm"
done

build="$work/build/gcc"
mkdir -p "$build"
cd "$build"
if [[ ! -f Makefile ]]; then
  emconfigure "$gcc_source/configure" --build="$build_triple" --host="$host" --target="$target" \
    --prefix=/opt/gcc-wasm --with-sysroot=/sysroot --enable-languages=c,c++ \
    --with-gmp="$wasmdeps" --with-mpfr="$wasmdeps" --with-mpc="$wasmdeps" \
    --disable-bootstrap --disable-shared --disable-threads --disable-nls \
    --disable-multilib --disable-libssp --disable-libada --disable-libquadmath \
    --disable-libgomp --disable-libvtv --disable-libstdcxx --disable-libsanitizer \
    --disable-libatomic --disable-libcc1 --disable-libitm --disable-lto --disable-plugin \
    --disable-werror --disable-checking --without-headers --with-arch=x86-64 --with-tune=generic \
    CC_FOR_BUILD=gcc-13 CXX_FOR_BUILD=g++-13 CFLAGS="$hostflags" CXXFLAGS="$hostflags" \
    GCC_FOR_TARGET=gcc-13 CXX_FOR_TARGET=g++-13 MAKEINFO=true
fi
# Configure support libraries and native gen* dependencies using the normal GCC
# graph. all-gcc includes unused gcov tools needing ftw(), absent in Emscripten.
# Record this bootstrap pass's status, then strictly require each shipped target.
set +e
emmake make -j"$jobs" all-gcc CFLAGS="$hostflags" CXXFLAGS="$hostflags" \
  GCC_FOR_TARGET=gcc-13 CXX_FOR_TARGET=g++-13 MAKEINFO=true
bootstrap_status=$?
set -e
printf '{"allGccBootstrapExitCode":%s,"shippedTargetsVerifiedSeparately":true}\n' "$bootstrap_status" > "$work/gcc-bootstrap.status.json"
# Force relinking with the module ABI after the support-library bootstrap.
rm -f gcc/cc1 gcc/cc1plus
emmake make -j"$jobs" -C gcc cc1 cc1plus \
  CFLAGS="$hostflags" CXXFLAGS="$hostflags" LDFLAGS="$moduleflags" MAKEINFO=true
emmake make -C gcc stmp-int-hdrs GCC_FOR_TARGET=gcc-13 MAKEINFO=true
for tool_name in cc1 cc1plus; do
  install -m644 "$build/gcc/$tool_name" "$output/$tool_name.mjs"
  install -m644 "$build/gcc/$tool_name.wasm" "$output/$tool_name.wasm"
done
mkdir "$output/resource-include" "$output/licenses"
cp -a "$build/gcc/include/." "$output/resource-include/"
# Header wrappers are generated by this exact GCC source, not replacements for
# GNU libc/libstdc++ headers. Target runtime libraries come from the GNU importer.
for required in stddef.h stdarg.h limits.h immintrin.h avx2intrin.h fmaintrin.h; do
  test -s "$output/resource-include/$required"
done
for component in gcc-13.3.0 binutils-2.42 gmp-6.3.0 mpfr-4.2.1 mpc-1.3.1; do
  mkdir "$output/licenses/$component"
  while IFS= read -r -d '' notice; do
    install -m644 "$notice" "$output/licenses/$component/$(basename "$notice")"
  done < <(find "$source_root/$component" -maxdepth 1 -type f \( -name 'COPYING*' -o -name 'COPYRIGHT*' -o -name 'LICENSE*' \) -print0)
done
install -m644 "$gcc_source/COPYING.RUNTIME" "$output/licenses/gcc-13.3.0/COPYING.RUNTIME"
install -m644 "$work/emsdk/upstream/emscripten/LICENSE" "$output/licenses/emscripten-LICENSE"
install -m644 "$EM_PORTS/zlib/zlib-1.3.1/LICENSE" "$output/licenses/zlib-1.3.1-LICENSE"
node "$script_dir/build-receipt.mjs" --compiler "$output" --work "$work"
printf 'GCC Wasm compiler built: %s\n' "$output"
