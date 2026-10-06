#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PRODUCER_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd "$PRODUCER_ROOT/../.." && pwd)
MANIFEST="$PRODUCER_ROOT/manifest.json"
CACHE_ROOT=${WASM_LLVM_V_BUILD_DIR:-$REPO_ROOT/out/v-browser-work}
DOWNLOAD_DIR="$CACHE_ROOT/downloads"
SOURCE_DIR="$CACHE_ROOT/source"
BUILD_DIR="$CACHE_ROOT/build"
VROOT_ROOT="$CACHE_ROOT/vroot-root"
C_SYSROOT_ROOT="$CACHE_ROOT/c-sysroot-root"
OUTPUT_DIR=${WASM_LLVM_V_ARTIFACT_DIR:-$REPO_ROOT/artifacts/v-browser}
WASI_SDK_PATH=${WASI_SDK_PATH:?Set WASI_SDK_PATH to an extracted wasi-sdk 33.0}
TMPDIR=${TMPDIR:-$CACHE_ROOT/tmp}
export TMPDIR

manifest() { node -p "const m=require('$MANIFEST'); $1"; }
V_COMMIT=$(manifest 'm.sources.v.commit')
V_REPOSITORY=$(manifest 'm.sources.v.repository')
V_VERSION=$(manifest 'm.sources.v.version')
VC_URL=$(manifest 'm.sources.vc.url')
VC_SHA=$(manifest 'm.sources.vc.sha256')
VC_BYTES=$(manifest 'm.sources.vc.bytes')
VC_GENERATED_FROM=$(manifest 'm.sources.vc.generatedFrom')
WASI_SDK_VERSION=$(manifest 'm.wasiSdk.version')
mapfile -t CFLAGS < <(manifest "m.compiler.cflags.join('\n')")
mapfile -t LDFLAGS < <(manifest "m.compiler.ldflags.join('\n')")
mapfile -t VLIB_MODULES < <(manifest "m.vlibModules.join('\n')")
mapfile -t THIRDPARTY < <(manifest "m.thirdparty.join('\n')")

CC="$WASI_SDK_PATH/bin/clang"
AR="$WASI_SDK_PATH/bin/llvm-ar"
SYSROOT="$WASI_SDK_PATH/share/wasi-sysroot"
WASI_LIB="$SYSROOT/lib/wasm32-wasi"
WASI_INCLUDE="$SYSROOT/include/wasm32-wasi"
COMPAT_INCLUDE="$PRODUCER_ROOT/compat/include"
COMPAT_FLAGS=(-I"$COMPAT_INCLUDE" -include v_wasi_compat.h)
EMULATION_LIBS=(-lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks
	-lwasi-emulated-getpid)

if [[ "$("$CC" --version | head -n 1)" != *"wasi-sdk"* ]]; then
	echo "WASI_SDK_PATH does not contain a wasi-sdk clang" >&2
	exit 1
fi
if [[ "$(cat "$WASI_SDK_PATH/VERSION" 2>/dev/null | head -n 1)" != "${WASI_SDK_VERSION%%.*}"* ]]; then
	echo "WASI_SDK_PATH is not wasi-sdk $WASI_SDK_VERSION" >&2
	exit 1
fi

mkdir -p "$DOWNLOAD_DIR" "$SOURCE_DIR" "$BUILD_DIR" "$OUTPUT_DIR" "$TMPDIR"

# The bootstrap C file is the upstream vlang/vc translation of the pinned V compiler.
if [[ ! -f "$DOWNLOAD_DIR/v.c" ]]; then
	curl -fL --retry 3 "$VC_URL" -o "$DOWNLOAD_DIR/v.c.partial"
	mv "$DOWNLOAD_DIR/v.c.partial" "$DOWNLOAD_DIR/v.c"
fi
echo "$VC_SHA  $DOWNLOAD_DIR/v.c" | sha256sum --check --status
[[ "$(stat -c %s "$DOWNLOAD_DIR/v.c")" == "$VC_BYTES" ]]
grep -q "^#define V_COMMIT_HASH \"$VC_GENERATED_FROM\"" "$DOWNLOAD_DIR/v.c"

# vlib and thirdparty sources come from the pinned V release commit (shallow, single commit).
if [[ ! -d "$SOURCE_DIR/v/.git" ]]; then
	rm -rf "$SOURCE_DIR/v"
	git init -q "$SOURCE_DIR/v"
	git -C "$SOURCE_DIR/v" fetch -q --depth 1 "$V_REPOSITORY" "$V_COMMIT"
	git -C "$SOURCE_DIR/v" checkout -q --detach FETCH_HEAD
fi
[[ "$(git -C "$SOURCE_DIR/v" rev-parse HEAD)" == "$V_COMMIT" ]]
if [[ -n "$(git -C "$SOURCE_DIR/v" status --porcelain --ignored)" ]]; then
	echo "V source checkout has local or ignored files" >&2
	exit 1
fi

# WASI compatibility archive: linked into the compiler and shipped for V programs.
"$CC" "${CFLAGS[@]}" "${COMPAT_FLAGS[@]}" -c "$PRODUCER_ROOT/compat/v-wasi-compat.c" \
	-o "$BUILD_DIR/v-wasi-compat.o"
rm -f "$BUILD_DIR/libvwasi.a"
"$AR" rcsD "$BUILD_DIR/libvwasi.a" "$BUILD_DIR/v-wasi-compat.o"

# The compiler itself. Clang -O2 miscompiles the V 0.5.2 checker for wasm32 (`&T{}` is then
# reported as `T`); -Os and -O1 produce a compiler whose C output matches the native compiler.
"$CC" "${CFLAGS[@]}" "${COMPAT_FLAGS[@]}" -c "$DOWNLOAD_DIR/v.c" -o "$BUILD_DIR/v.o"
"$CC" --target=wasm32-wasi -o "$BUILD_DIR/v.wasm" "$BUILD_DIR/v.o" "$BUILD_DIR/libvwasi.a" \
	"${EMULATION_LIBS[@]}" "${LDFLAGS[@]}"
rm -f "$BUILD_DIR/v.o"

# V root: VEXE=/v/v makes the compiler resolve /v/vlib and /v/thirdparty.
rm -rf "$VROOT_ROOT"
mkdir -p "$VROOT_ROOT/v/vlib" "$VROOT_ROOT/v/thirdparty"
for module in "${VLIB_MODULES[@]}"; do
	(cd "$SOURCE_DIR/v/vlib" && find "$module" -type f \
		! -name '*_test.v' ! -name '*_test.c.v' ! -name '*.md' \
		! -path '*/tests/*' ! -path '*/testdata/*' ! -path '*/examples/*' -print0) |
		(cd "$SOURCE_DIR/v/vlib" && xargs -0 cp --parents -t "$VROOT_ROOT/v/vlib")
done
for dir in "${THIRDPARTY[@]}"; do
	cp -r "$SOURCE_DIR/v/thirdparty/$dir" "$VROOT_ROOT/v/thirdparty/"
done
cp "$SOURCE_DIR/v/LICENSE" "$VROOT_ROOT/v/LICENSE"

# C sysroot for the browser clang: complete wasi-libc C headers, the libraries V programs link,
# the V compatibility headers and archive.
rm -rf "$C_SYSROOT_ROOT"
mkdir -p "$C_SYSROOT_ROOT/include" "$C_SYSROOT_ROOT/lib/wasm32-wasi" \
	"$C_SYSROOT_ROOT/lib/clang/22/lib/wasi" "$C_SYSROOT_ROOT/include/v-wasi"
mkdir -p "$C_SYSROOT_ROOT/include/wasm32-wasi"
(cd "$WASI_INCLUDE" && find . \( -path ./c++ -o -path ./eh -o -path ./noeh \) -prune -o -type f -print0 |
	xargs -0 cp --parents -t "$C_SYSROOT_ROOT/include/wasm32-wasi")
for lib in crt1.o libc.a libm.a libwasi-emulated-mman.a libwasi-emulated-signal.a \
	libwasi-emulated-process-clocks.a libwasi-emulated-getpid.a; do
	cp "$WASI_LIB/$lib" "$C_SYSROOT_ROOT/lib/wasm32-wasi/"
done
cp "$BUILD_DIR/libvwasi.a" "$C_SYSROOT_ROOT/lib/wasm32-wasi/"
cp "$WASI_SDK_PATH/lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a" \
	"$C_SYSROOT_ROOT/lib/clang/22/lib/wasi/libclang_rt.builtins-wasm32.a"
cp -r "$COMPAT_INCLUDE/." "$C_SYSROOT_ROOT/include/v-wasi/"
# The llvm-core Clang host installs its GCC compatibility headers below this directory.
mkdir -p "$C_SYSROOT_ROOT/include/c++/v1/ext"

deterministic_tar() {
	tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=u=rwX,go=rX \
		-C "$1" -cf "$2" .
	chmod 0644 "$2"
	TZ=UTC touch -d @315532800 "$2"
}
deterministic_zip() {
	local directory=$1 entry=$2 output=$3
	rm -f "$output"
	(cd "$directory" && TZ=UTC zip -X -9 -q "$output" "$entry")
}

cp "$BUILD_DIR/v.wasm" "$CACHE_ROOT/v"
chmod 0644 "$CACHE_ROOT/v"
TZ=UTC touch -d @315532800 "$CACHE_ROOT/v"
deterministic_zip "$CACHE_ROOT" v "$OUTPUT_DIR/v.zip"
deterministic_tar "$VROOT_ROOT" "$CACHE_ROOT/vroot.tar"
deterministic_zip "$CACHE_ROOT" vroot.tar "$OUTPUT_DIR/vroot.tar.zip"
deterministic_tar "$C_SYSROOT_ROOT" "$CACHE_ROOT/c-sysroot.tar"
deterministic_zip "$CACHE_ROOT" c-sysroot.tar "$OUTPUT_DIR/c-sysroot.tar.zip"

# Real compile/run acceptance: the Wasm V compiler translates the fixtures inside the shipped V
# root, the generated C is compiled against the shipped C sysroot, and the program reads stdin.
node "$SCRIPT_DIR/smoke.mjs" --work "$CACHE_ROOT/smoke" --wasi-sdk "$WASI_SDK_PATH" \
	--artifacts "$OUTPUT_DIR" --receipt "$CACHE_ROOT/smoke-receipt.json"

FRONTEND_LLVM_VERSION=$("$CC" --version | sed -n '1s/.*version \([^ ]*\).*/\1/p')
node "$SCRIPT_DIR/write-receipt.mjs" "$OUTPUT_DIR" "$V_VERSION" "$WASI_SDK_VERSION" \
	"$FRONTEND_LLVM_VERSION" "$CACHE_ROOT/smoke-receipt.json"

if [[ "${WASM_LLVM_V_KEEP_BUILD:-0}" != 1 ]]; then
	rm -rf "$BUILD_DIR" "$VROOT_ROOT" "$C_SYSROOT_ROOT" "$CACHE_ROOT/smoke" "$CACHE_ROOT/v" \
		"$CACHE_ROOT/vroot.tar" "$CACHE_ROOT/c-sysroot.tar"
fi
sha256sum "$OUTPUT_DIR/v.zip" "$OUTPUT_DIR/vroot.tar.zip" "$OUTPUT_DIR/c-sysroot.tar.zip"
