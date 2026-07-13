#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PRODUCER_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd "$PRODUCER_ROOT/../.." && pwd)
MANIFEST="$PRODUCER_ROOT/manifest.json"
CACHE_ROOT=${WASM_COBOL_BUILD_DIR:-/tmp/wasm-llvm-cobol-browser}
DOWNLOAD_DIR="$CACHE_ROOT/downloads"
SOURCE_DIR="$CACHE_ROOT/source"
BUILD_DIR="$CACHE_ROOT/build"
INSTALL_DIR="$CACHE_ROOT/install"
PACKAGE_ROOT="$CACHE_ROOT/package-root"
C_SYSROOT_ROOT="$CACHE_ROOT/c-sysroot-root"
OUTPUT_DIR=${WASM_COBOL_OUTPUT_DIR:-$REPO_ROOT/artifacts/cobol-runtime-source}
WASI_SDK_PATH=${WASI_SDK_PATH:?Set WASI_SDK_PATH to wasi-sdk 33.0}

GN_VERSION=$(node -p "require('$MANIFEST').gnucobol.version")
GN_URL=$(node -p "require('$MANIFEST').gnucobol.url")
GN_SHA=$(node -p "require('$MANIFEST').gnucobol.sha256")
GMP_VERSION=$(node -p "require('$MANIFEST').gmp.version")
GMP_URL=$(node -p "require('$MANIFEST').gmp.url")
GMP_SHA=$(node -p "require('$MANIFEST').gmp.sha256")
WASI_SDK_VERSION=$(node -p "require('$MANIFEST').wasiSdk.version")
CC="$WASI_SDK_PATH/bin/clang"
AR="$WASI_SDK_PATH/bin/llvm-ar"
NM="$WASI_SDK_PATH/bin/llvm-nm"
RANLIB="$WASI_SDK_PATH/bin/llvm-ranlib"
SYSROOT="$WASI_SDK_PATH/share/wasi-sysroot"
WASI_LIB="$SYSROOT/lib/wasm32-wasip1"
BUILD_TRIPLET=$(cc -dumpmachine)

mkdir -p "$DOWNLOAD_DIR" "$SOURCE_DIR" "$BUILD_DIR" "$INSTALL_DIR" "$OUTPUT_DIR"

download() {
	local url=$1 output=$2 sha=$3
	if [[ ! -f "$output" ]]; then
		curl -fL --retry 3 "$url" -o "$output"
	fi
	echo "$sha  $output" | sha256sum --check --status
}

download "$GN_URL" "$DOWNLOAD_DIR/gnucobol-$GN_VERSION.tar.xz" "$GN_SHA"
download "$GMP_URL" "$DOWNLOAD_DIR/gmp-$GMP_VERSION.tar.xz" "$GMP_SHA"
rm -rf "$SOURCE_DIR/gnucobol-$GN_VERSION" "$SOURCE_DIR/gmp-$GMP_VERSION"
tar -C "$SOURCE_DIR" -xf "$DOWNLOAD_DIR/gnucobol-$GN_VERSION.tar.xz"
tar -C "$SOURCE_DIR" -xf "$DOWNLOAD_DIR/gmp-$GMP_VERSION.tar.xz"

rm -rf "$BUILD_DIR/gmp" "$INSTALL_DIR/gmp"
mkdir -p "$BUILD_DIR/gmp" "$INSTALL_DIR/gmp"
(
	cd "$BUILD_DIR/gmp"
	CC="$CC" AR="$AR" NM="$NM" RANLIB="$RANLIB" CC_FOR_BUILD=cc \
		ac_cv_func_raise=yes \
		"$SOURCE_DIR/gmp-$GMP_VERSION/configure" \
		--build="$BUILD_TRIPLET" --host=wasm32-unknown-wasi \
		--prefix="$INSTALL_DIR/gmp" --disable-assembly --disable-shared --enable-static
	make -j"${JOBS:-4}" CFLAGS='-O2 -D_WASI_EMULATED_SIGNAL'
	make install CFLAGS='-O2 -D_WASI_EMULATED_SIGNAL'
)

COMPAT_C="$PRODUCER_ROOT/compat/gnucobol-wasi-compat.c"
COMPAT_H="$PRODUCER_ROOT/compat/gnucobol-wasi-compat.h"
COMPAT_O="$BUILD_DIR/gnucobol-wasi-compat.o"
"$CC" --target=wasm32-wasip1 -O2 -c "$COMPAT_C" -o "$COMPAT_O"

rm -rf "$BUILD_DIR/gnucobol"
mkdir -p "$BUILD_DIR/gnucobol"
(
	cd "$BUILD_DIR/gnucobol"
	CC="$CC" AR="$AR" NM="$NM" RANLIB="$RANLIB" \
		CFLAGS="-O2 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_GETPID -mllvm -wasm-enable-sjlj -include $COMPAT_H" \
		CPPFLAGS="-I$INSTALL_DIR/gmp/include" \
		LDFLAGS="-L$INSTALL_DIR/gmp/lib -L$WASI_LIB" \
		LIBS="$COMPAT_O -lsetjmp -lwasi-emulated-getpid -lwasi-emulated-signal" \
		GMP_CFLAGS="-I$INSTALL_DIR/gmp/include" \
		GMP_LIBS="-L$INSTALL_DIR/gmp/lib -lgmp -lwasi-emulated-getpid -lwasi-emulated-signal" \
		ac_cv_func_fcntl=no \
		"$SOURCE_DIR/gnucobol-$GN_VERSION/configure" \
		--build="$BUILD_TRIPLET" --host=wasm32-unknown-wasi --prefix=/ \
		--without-db --without-curses --without-xml2 --with-json=no --with-dl \
		--disable-nls --disable-shared --enable-static
	make -j"${JOBS:-4}" -C libcob libcob.la
	make -j"${JOBS:-4}" -C lib libsupport.la
	make -j"${JOBS:-4}" -C cobc cobc
)

rm -rf "$PACKAGE_ROOT"
mkdir -p "$PACKAGE_ROOT/share/gnucobol/config" "$PACKAGE_ROOT/share/gnucobol/copy" \
	"$PACKAGE_ROOT/include/libcob" "$PACKAGE_ROOT/lib"
cp "$SOURCE_DIR/gnucobol-$GN_VERSION/config/default.conf" \
	"$PACKAGE_ROOT/share/gnucobol/config/"
cp "$SOURCE_DIR/gnucobol-$GN_VERSION"/copy/*.cpy "$PACKAGE_ROOT/share/gnucobol/copy/"
cp "$SOURCE_DIR/gnucobol-$GN_VERSION/libcob.h" "$PACKAGE_ROOT/include/"
cp "$SOURCE_DIR/gnucobol-$GN_VERSION/libcob/common.h" \
	"$SOURCE_DIR/gnucobol-$GN_VERSION/libcob/exception-io.def" \
	"$SOURCE_DIR/gnucobol-$GN_VERSION/libcob/exception.def" \
	"$SOURCE_DIR/gnucobol-$GN_VERSION/libcob/statement.def" \
	"$SOURCE_DIR/gnucobol-$GN_VERSION/libcob/version.h" "$PACKAGE_ROOT/include/libcob/"
cp "$INSTALL_DIR/gmp/include/gmp.h" "$PACKAGE_ROOT/include/"
cp "$BUILD_DIR/gnucobol/libcob/.libs/libcob.a" "$INSTALL_DIR/gmp/lib/libgmp.a" "$PACKAGE_ROOT/lib/"
"$AR" rcs "$PACKAGE_ROOT/lib/libcobwasi.a" "$COMPAT_O"
cp "$WASI_LIB/libdl.a" "$WASI_LIB/libsetjmp.a" "$WASI_LIB/libwasi-emulated-getpid.a" \
	"$WASI_LIB/libwasi-emulated-signal.a" "$PACKAGE_ROOT/lib/"

rm -f "$OUTPUT_DIR/cobc.zip" "$OUTPUT_DIR/rootfs.tar.zip" "$CACHE_ROOT/cobc" "$CACHE_ROOT/rootfs.tar"
cp "$BUILD_DIR/gnucobol/cobc/cobc" "$CACHE_ROOT/cobc"
chmod 0644 "$CACHE_ROOT/cobc"
TZ=UTC touch -d @315532800 "$CACHE_ROOT/cobc"
(cd "$CACHE_ROOT" && TZ=UTC zip -X -9 -q "$OUTPUT_DIR/cobc.zip" cobc)
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
	-C "$PACKAGE_ROOT" -cf "$CACHE_ROOT/rootfs.tar" .
TZ=UTC touch -d @315532800 "$CACHE_ROOT/rootfs.tar"
(cd "$CACHE_ROOT" && TZ=UTC zip -X -9 -q "$OUTPUT_DIR/rootfs.tar.zip" rootfs.tar)

rm -rf "$C_SYSROOT_ROOT"
mkdir -p "$C_SYSROOT_ROOT"
unzip -p "$REPO_ROOT/artifacts/runtime-source/sysroot.tar.zip" > "$CACHE_ROOT/c-sysroot.tar"
tar -C "$C_SYSROOT_ROOT" -xf "$CACHE_ROOT/c-sysroot.tar"
rm -rf "$C_SYSROOT_ROOT/include/c++"
rm -f "$C_SYSROOT_ROOT/lib/wasm32-wasi/libc++.a" \
	"$C_SYSROOT_ROOT/lib/wasm32-wasi/libc++abi.a"
mkdir -p "$C_SYSROOT_ROOT/include/c++/v1/ext"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
	-C "$C_SYSROOT_ROOT" -cf "$CACHE_ROOT/c-sysroot.tar" .
TZ=UTC touch -d @315532800 "$CACHE_ROOT/c-sysroot.tar"
rm -f "$OUTPUT_DIR/c-sysroot.tar.zip"
(cd "$CACHE_ROOT" && TZ=UTC zip -X -9 -q "$OUTPUT_DIR/c-sysroot.tar.zip" c-sysroot.tar)

FRONTEND_LLVM_VERSION=$("$CC" --version | sed -n '1s/.*version \([^ ]*\).*/\1/p')
node --input-type=module -e '
	import { writeFileSync } from "node:fs";
	const [output, gnucobolVersion, gmpVersion, wasiSdkVersion, frontendLlvmVersion] =
		process.argv.slice(1);
	writeFileSync(
		output,
		JSON.stringify(
			{
				version: `gnucobol-${gnucobolVersion}-wasi-preview1-v1`,
				gnucobolVersion,
				gmpVersion,
				wasiSdkVersion,
				frontendLlvmVersion,
				frontendTarget: "wasm32-wasi",
				backend: "wasm-llvm-clang"
			},
			null,
			2
		) + "\n"
	);
' "$OUTPUT_DIR/toolchain.json" "$GN_VERSION" "$GMP_VERSION" "$WASI_SDK_VERSION" \
	"$FRONTEND_LLVM_VERSION"

sha256sum "$OUTPUT_DIR/cobc.zip" "$OUTPUT_DIR/rootfs.tar.zip" \
	"$OUTPUT_DIR/c-sysroot.tar.zip"
