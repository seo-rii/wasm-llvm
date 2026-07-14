#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCER_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PRODUCER_ROOT/../.." && pwd)"
WORK_DIR="${WASM_LLVM_RUST_BROWSER_WORK_DIR:-$REPO_ROOT/artifacts/rust-browser-producer}"
OUT_DIR="${WASM_LLVM_RUST_BROWSER_OUT_DIR:-$WORK_DIR/output}"
JOBS="${NINJA_JOBS:-${WASM_LLVM_RUST_BROWSER_JOBS:-8}}"
BUILD_TRIPLE="x86_64-unknown-linux-gnu"
COMPILER_HOST="wasm32-wasip1-threads"
SOURCE_DATE_EPOCH=1783912447
RUST_BOOTSTRAP_DATE=2026-05-31

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  printf 'rust-browser producer currently requires x86_64 Linux\n' >&2
  exit 2
fi

for command in bash cmake curl git make ninja node python3 tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$command" >&2
    exit 2
  fi
done

export SOURCE_DATE_EPOCH TZ=UTC LC_ALL=C LANG=C ZERO_AR_DATE=1
export CARGO_INCREMENTAL=0 CARGO_PROFILE_RELEASE_INCREMENTAL=false
export PYTHONDONTWRITEBYTECODE=1
export CARGO_HOME="${CARGO_HOME:-$WORK_DIR/cargo-home}"
export TMPDIR="${TMPDIR:-$WORK_DIR/tmp}"
mkdir -p "$CARGO_HOME" "$TMPDIR"

node "$SCRIPT_DIR/producer.mjs" prepare --work-dir "$WORK_DIR" --out-dir "$OUT_DIR"

BUILD_ROOT="$WORK_DIR/build"
STAMP_ROOT="$BUILD_ROOT/stamps"
RUST_SRC="$WORK_DIR/patched/rust"
RUST_BUILD="$BUILD_ROOT/rust-build"
LLVM_SRC="$WORK_DIR/patched/llvm"
GCC_SRC="$WORK_DIR/patched/gcc"
WASI_LIBC_SRC="$WORK_DIR/patched/wasiLibc"
LLVM_HOST="$BUILD_ROOT/llvm-host-build"
SYSROOT="$BUILD_ROOT/sysroot"
TOOLCHAIN_FILE="$PRODUCER_ROOT/config/toolchain.cmake"
BUILTINS_ARCHIVE_ROOT="$WORK_DIR/downloads/bootstrapBuiltins/libclang_rt.builtins-wasm32-wasi-25.0"
BUILTINS_LIB="$BUILTINS_ARCHIVE_ROOT/libclang_rt.builtins-wasm32.a"
LLVM_VERSION_MAJOR=22
RT_DIR=wasm32-unknown-wasip1-threads
INITIAL_MEMORY=419430400
MAXIMUM_MEMORY=4294967296
STACK_SIZE=33554432
PATH_MAP="-ffile-prefix-map=$WORK_DIR=/wasm-llvm-rust-browser"
RUST_PATH_MAP="--remap-path-prefix=$WORK_DIR=/wasm-llvm-rust-browser"
WASM_CC="$LLVM_HOST/bin/clang"
WASM_CXX="$LLVM_HOST/bin/clang++"
WASM_AR="$LLVM_HOST/bin/llvm-ar"
WASM_NM="$LLVM_HOST/bin/llvm-nm"
WASM_CFLAGS="$PATH_MAP -matomics -mbulk-memory -mmutable-globals -Oz"
WASM_CXXFLAGS="$WASM_CFLAGS -stdlib=libstdc++ -I$SYSROOT/include/c++/15.0.0/wasm32-wasip1 -I$SYSROOT/include/c++/15.0.0 -fno-exceptions"
WASM_LDFLAGS="-Wl,-z,stack-size=$STACK_SIZE -Wl,--shared-memory -Wl,--export-memory -Wl,--import-memory -Wl,--max-memory=$MAXIMUM_MEMORY -Wl,--initial-memory=$INITIAL_MEMORY -L$SYSROOT/lib"

mkdir -p "$BUILD_ROOT" "$STAMP_ROOT" "$SYSROOT" "$OUT_DIR"

phase() {
  local name="$1"
  shift
  local stamp="$STAMP_ROOT/$name.done"
  if [[ -f "$stamp" ]]; then
    printf '==> reuse %s\n' "$name"
    return
  fi
  printf '==> build %s\n' "$name"
  "$@"
  printf '%s\n' "$SOURCE_DATE_EPOCH" > "$stamp"
}

build_host_llvm() {
  cmake -S "$LLVM_SRC/llvm" -B "$BUILD_ROOT/llvm-host-build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="$PATH_MAP" \
    -DCMAKE_CXX_FLAGS="$PATH_MAP -w" \
    -DDEFAULT_SYSROOT="$SYSROOT" \
    -DLLVM_TARGETS_TO_BUILD='WebAssembly;X86' \
    -DLLVM_DEFAULT_TARGET_TRIPLE="$COMPILER_HOST" \
		-DLLVM_ENABLE_PROJECTS='clang;lld' \
    -DLLVM_INSTALL_UTILS=ON \
    -DLLVM_ENABLE_ZLIB=OFF \
    -DLLVM_ENABLE_ZSTD=OFF \
    -DLLVM_ENABLE_CURL=OFF \
    -DLLVM_ENABLE_LIBXML2=OFF \
    -DLLVM_ENABLE_TERMINFO=OFF
  ninja -C "$BUILD_ROOT/llvm-host-build" -j "$JOBS" \
    clang lld FileCheck LLVMMCA LLVMX86TargetMCA \
    llvm-ar llvm-nm llvm-ranlib llvm-config llvm-tblgen clang-tblgen
  cmake -E rm -f \
    "$LLVM_HOST/bin/clang++" \
    "$LLVM_HOST/bin/wasm-ld" \
    "$LLVM_HOST/bin/wasm-component-ld"
  cmake -E create_symlink clang "$LLVM_HOST/bin/clang++"
  cmake -E create_symlink lld "$LLVM_HOST/bin/wasm-ld"
  cmake -E create_symlink lld "$LLVM_HOST/bin/wasm-component-ld"
  for tool in clang clang++ wasm-ld wasm-component-ld FileCheck llvm-ar llvm-nm llvm-ranlib llvm-config llvm-tblgen clang-tblgen; do
    test -x "$LLVM_HOST/bin/$tool"
  done
}

build_wasi_libc_variant() {
  local variant="$1"
  local thread_model="$2"
  local snapshot="$3"
  local triple="$4"
  local extra_flags="$PATH_MAP -O2 -DNDEBUG"
  if [[ "$thread_model" == "posix" ]]; then
    extra_flags="$extra_flags -matomics -mbulk-memory -mmutable-globals"
  fi
  make -C "$WASI_LIBC_SRC" -j "$JOBS" install \
    OBJDIR="$BUILD_ROOT/wasi-libc-$variant-obj" \
    SYSROOT="$BUILD_ROOT/wasi-libc-$variant-sysroot" \
    INSTALL_DIR="$SYSROOT" \
    CC="$WASM_CC" AR="$WASM_AR" NM="$WASM_NM" \
    BUILTINS_LIB="$BUILTINS_LIB" \
    THREAD_MODEL="$thread_model" WASI_SNAPSHOT="$snapshot" TARGET_TRIPLE="$triple" \
    EXTRA_CFLAGS="$extra_flags"
}

build_wasi_libc() {
  build_wasi_libc_variant wasip1 single p1 wasm32-wasip1
  build_wasi_libc_variant wasip2 single p2 wasm32-wasip2
  build_wasi_libc_variant wasip1-threads posix p1 wasm32-wasip1-threads
  test -f "$SYSROOT/lib/wasm32-wasip1/libc.a"
  test -f "$SYSROOT/lib/wasm32-wasip2/libc.a"
  test -f "$SYSROOT/lib/wasm32-wasip1-threads/libc.a"
}

configure_compiler_rt() {
  local build_dir="$1"
  local install_prefix="$2"
  cmake -S "$LLVM_SRC/compiler-rt/lib/builtins" -B "$build_dir" -G Ninja \
    -DWASM_PREFIX="$LLVM_HOST" \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE" \
    -DCMAKE_C_FLAGS="-I$PRODUCER_ROOT $WASM_CFLAGS" \
    -DCOMPILER_RT_BAREMETAL_BUILD=ON \
    -DCOMPILER_RT_INCLUDE_TESTS=OFF \
    -DCOMPILER_RT_HAS_FPIC_FLAG=OFF \
    -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON \
    -DCOMPILER_RT_OS_DIR="$RT_DIR" \
    -DCMAKE_INSTALL_PREFIX="$install_prefix"
}

build_compiler_rt() {
  configure_compiler_rt "$BUILD_ROOT/compiler-rt-host-build" "$LLVM_HOST/lib/clang/$LLVM_VERSION_MAJOR"
  ninja -C "$BUILD_ROOT/compiler-rt-host-build" -j "$JOBS" install
  mv "$LLVM_HOST/lib/clang/$LLVM_VERSION_MAJOR/lib/$RT_DIR/libclang_rt.builtins-wasm32.a" \
    "$LLVM_HOST/lib/clang/$LLVM_VERSION_MAJOR/lib/$RT_DIR/libclang_rt.builtins.a"

  configure_compiler_rt "$BUILD_ROOT/compiler-rt-cross-build" "$SYSROOT/lib/clang/$LLVM_VERSION_MAJOR"
  ninja -C "$BUILD_ROOT/compiler-rt-cross-build" -j "$JOBS" install
  mv "$SYSROOT/lib/clang/$LLVM_VERSION_MAJOR/lib/$RT_DIR/libclang_rt.builtins-wasm32.a" \
    "$SYSROOT/lib/clang/$LLVM_VERSION_MAJOR/lib/$RT_DIR/libclang_rt.builtins.a"
}

build_libstdcxx() {
  mkdir -p "$BUILD_ROOT/gcc-build"
  (
    cd "$BUILD_ROOT/gcc-build"
    PATH="$LLVM_HOST/bin:$PATH" \
      LDFLAGS="$WASM_LDFLAGS" \
      CXXFLAGS="-fsized-deallocation -Wno-unknown-warning-option -Wno-vla-cxx-extension -Wno-unused-function -Wno-instantiation-after-specialization -Wno-missing-braces -Wno-unused-variable -Wno-string-plus-int -Wno-unused-parameter -fno-exceptions -Wno-init-priority-reserved -Wno-invalid-constexpr -nostdlib++ $WASM_CXXFLAGS" \
      "$GCC_SRC/libstdc++-v3/configure" \
        --prefix="$SYSROOT" \
        --host=wasm32-wasip1 \
        --target=wasm32-wasip1 \
        --build="$(${CC:-cc} -dumpmachine)" \
        CC="$WASM_CC" CXX="$WASM_CXX" AR="$WASM_AR" NM="$WASM_NM" \
        --enable-libstdcxx-threads \
        --disable-shared \
        --disable-libstdcxx-dual-abi \
        --enable-libstdcxx-filesystem-ts \
        --enable-libstdcxx-time=yes
    PATH="$LLVM_HOST/bin:$PATH" make -j "$JOBS" \
      CFLAGS_FOR_TARGET="$WASM_CFLAGS -fsized-deallocation" \
      CXXFLAGS_FOR_TARGET="$WASM_CXXFLAGS" install
  )
}

build_cross_llvm() {
  cmake -S "$LLVM_SRC/llvm" -B "$BUILD_ROOT/llvm-build" -G Ninja \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    -DCMAKE_SYSROOT="$SYSROOT" \
    -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
    -DDEFAULT_SYSROOT=/ \
    -DWASM_PREFIX="$LLVM_HOST" \
    -DLLVM_NATIVE_TOOL_DIR="$LLVM_HOST/bin" \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE" \
    -DCMAKE_C_FLAGS="-I$PRODUCER_ROOT $WASM_CFLAGS" \
    -DCMAKE_CXX_FLAGS="-I$PRODUCER_ROOT $WASM_CXXFLAGS" \
    -DCMAKE_EXE_LINKER_FLAGS="$WASM_LDFLAGS" \
    -DCMAKE_C_FLAGS_MINSIZEREL='-Oz -DNDEBUG' \
    -DCMAKE_CXX_FLAGS_MINSIZEREL='-Oz -DNDEBUG' \
    -DCMAKE_ASM_FLAGS_MINSIZEREL='-Oz -DNDEBUG' \
    -DLLVM_ENABLE_PROJECTS='lld' \
    -DLLVM_TOOL_LLVM_DRIVER_BUILD=ON \
		-DLLVM_TARGETS_TO_BUILD='WebAssembly' \
    -DLLVM_DEFAULT_TARGET_TRIPLE="$COMPILER_HOST" \
    -DLLVM_INCLUDE_TESTS=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_INCLUDE_UTILS=OFF \
    -DLLVM_BUILD_UTILS=OFF \
    -DLLVM_BUILD_LLVM_DYLIB=OFF \
    -DLLVM_ENABLE_PIC=OFF \
    -DLLVM_ENABLE_PLUGINS=OFF \
    -DLLVM_ENABLE_ZLIB=OFF \
    -DLLVM_ENABLE_ZSTD=OFF \
    -DLLVM_ENABLE_CURL=OFF \
    -DLLVM_ENABLE_LIBXML2=OFF \
    -DLLVM_ENABLE_TERMINFO=OFF \
    -DCLANG_PLUGIN_SUPPORT=OFF \
    -DHAVE_DLOPEN=0

  local components=(
    ipo bitreader bitwriter linker asmparser lto dtlto coverage instrumentation webassembly
  )
  local lib_names_output
  lib_names_output="$("$LLVM_HOST/bin/llvm-config" --link-static --libnames "${components[@]}")"
  local lib_names=()
  read -r -a lib_names <<< "$lib_names_output"
  local targets=(lldCommon lldELF lldWasm LLVMOption)
  local lib_name
  for lib_name in "${lib_names[@]}"; do
    if [[ "$lib_name" =~ ^lib(.+)\.a$ ]]; then
      targets+=("${BASH_REMATCH[1]}")
    else
      printf 'unexpected llvm-config library name: %s\n' "$lib_name" >&2
      exit 2
    fi
  done
  ninja -C "$BUILD_ROOT/llvm-build" -j "$JOBS" "${targets[@]}"
}

build_rust() {
  local cache="$RUST_BUILD/cache/$RUST_BOOTSTRAP_DATE"
  mkdir -p "$cache"
  for archive in \
    cargo-beta-x86_64-unknown-linux-gnu.tar.xz \
    rust-std-beta-x86_64-unknown-linux-gnu.tar.xz \
    rustc-beta-x86_64-unknown-linux-gnu.tar.xz \
    rustc-nightly-x86_64-unknown-linux-gnu.tar.xz \
    rustfmt-nightly-x86_64-unknown-linux-gnu.tar.xz; do
    cp "$WORK_DIR/downloads/$archive" "$cache/$archive"
  done
  (
    cd "$RUST_SRC"
    PATH="$LLVM_HOST/bin:$PATH" \
      LLD_INCLUDE_DIR="$LLVM_SRC/lld/include" \
      RUSTFLAGS_BOOTSTRAP="$RUST_PATH_MAP" \
      ./x.py build \
        --config "$BUILD_ROOT/rust-config.toml" \
        --stage 2 \
        --host "$COMPILER_HOST" \
        compiler std
  )
}

copy_directory_contents() {
  local source="$1"
  local destination="$2"
  mkdir -p "$destination"
  cp -a "$source"/. "$destination"/
}

package_rust() {
	local rustc="$RUST_BUILD/$COMPILER_HOST/stage2/bin/rustc.wasm"
	local compiler_lib="$RUST_BUILD/$COMPILER_HOST/stage2/lib"
  test -f "$rustc"
  test -d "$compiler_lib"
  mkdir -p "$OUT_DIR/rust/bin" "$OUT_DIR/rust/lib"
  cp "$rustc" "$OUT_DIR/rust/bin/rustc.wasm"
  copy_directory_contents "$compiler_lib" "$OUT_DIR/rust/lib"

  for target in wasm32-wasip1 wasm32-wasip2 wasm32-wasip3; do
		local target_lib="$RUST_BUILD/$BUILD_TRIPLE/stage2/lib/rustlib/$target/lib"
    test -d "$target_lib"
    copy_directory_contents "$target_lib" "$OUT_DIR/rust/lib/rustlib/$target/lib"
  done
  rm -rf "$OUT_DIR/rust/lib/rustlib/rustc-src" "$OUT_DIR/rust/lib/rustlib/src"
}

phase llvm-host build_host_llvm
phase wasi-libc build_wasi_libc
phase compiler-rt build_compiler_rt
phase libstdcxx build_libstdcxx
phase llvm-cross build_cross_llvm
phase rust-stage2 build_rust
phase rust-package package_rust

node "$SCRIPT_DIR/producer.mjs" attest --work-dir "$WORK_DIR" --out-dir "$OUT_DIR"
node "$SCRIPT_DIR/producer.mjs" verify-output --work-dir "$WORK_DIR" --out-dir "$OUT_DIR"
