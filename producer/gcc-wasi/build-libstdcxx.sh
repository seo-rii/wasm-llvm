#!/usr/bin/env bash
# Build the pinned GCC tree's real libstdc++ with its GCC WebAssembly backend.
# This uses an isolated runtime source copy; an active GCC compiler build is never edited.
set -euo pipefail
recipe=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=${GCC_WASI_WORK_DIR:?Set GCC_WASI_WORK_DIR}
sdk=${WASI_SDK_PATH:?Set WASI_SDK_PATH to wasi-sdk-33.0}
jobs=${GCC_WASI_JOBS:-2}
[[ $jobs =~ ^[1-9][0-9]*$ ]] || exit 2
work=$(realpath "$work")
sdk=$(realpath "$sdk")
runtime=${GCC_LIBSTDCXX_WORK_DIR:-$work/libstdcxx}
mkdir -p "$runtime"
runtime=$(realpath "$runtime")
case "$runtime$sdk$work" in *[[:space:]]*) echo 'GCC specs require build paths without whitespace' >&2; exit 2;; esac
revision=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["gcc"]["commit"])' "$recipe/sources.lock.json")
[[ $(git -C "$work/gcc" rev-parse HEAD) == "$revision" ]] || { echo 'GCC source revision mismatch' >&2; exit 2; }
gcc_source=$(python3 "$recipe/prepare-source.py" --source "$work/gcc")
source_digest=$(printf '%s\n' "$gcc_source" | sha256sum | cut -d' ' -f1)
patch_file="$recipe/patches/libstdcxx-wasi-config.patch"
patch_digest=$(sha256sum "$patch_file" | cut -d' ' -f1)
errno_patch="$recipe/patches/wasi-libc-errno.patch"
errno_patch_digest=$(sha256sum "$errno_patch" | cut -d' ' -f1)
recipe_digest=$(sha256sum "$recipe/build-libstdcxx.sh" | cut -d' ' -f1)
source="$runtime/source"
if [[ -d $source ]]; then
  [[ $(cat "$runtime/source-inputs.txt") == "$revision $patch_digest $source_digest $errno_patch_digest $recipe_digest" ]] || {
    echo 'Runtime source inputs changed; select a new GCC_LIBSTDCXX_WORK_DIR' >&2; exit 2;
  }
else
  mkdir -p "$source/gcc" "$source/contrib"
  cp -p "$work/gcc/contrib/relpath.sh" "$source/contrib/"
  for dir in libstdc++-v3 config include libgcc libiberty libbacktrace; do
    cp -a "$work/gcc/$dir" "$source/"
  done
  for file in "$work/gcc"/*.m4; do cp -p "$file" "$source/"; done
  for file in config.guess config.sub config-ml.in ltmain.sh libtool-ldflags missing install-sh depcomp compile mkinstalldirs move-if-change COPYING COPYING3 COPYING.RUNTIME; do
    if [[ -f $work/gcc/$file ]]; then cp -p "$work/gcc/$file" "$source/"; fi
  done
  for file in BASE-VER DATESTAMP DEV-PHASE; do cp -p "$work/gcc/gcc/$file" "$source/gcc/"; done
  patch --batch --forward -d "$source" -p1 < "$patch_file"
  printf '%s %s %s %s %s\n' "$revision" "$patch_digest" "$source_digest" "$errno_patch_digest" "$recipe_digest" > "$runtime/source-inputs.txt"
fi

printf '%s\n' "$gcc_source" > "$runtime/gcc-source.json"

# GCC's checked-in m4 framework requires exactly Autoconf 2.69.
tools="$work/libstdcxx-tools"
mkdir -p "$tools"
archive="$tools/autoconf-2.69.tar.xz"
autoconf_sha=64ebcec9f8ac5b2487125a86a7760d2591ac9e1d3dbd59489633f9de62a57684
if [[ ! -f $archive ]]; then
  curl --fail --location --silent --show-error https://ftp.gnu.org/gnu/autoconf/autoconf-2.69.tar.xz -o "$archive"
fi
printf '%s  %s\n' "$autoconf_sha" "$archive" | sha256sum --check --status
if [[ ! -x $tools/install/bin/autoconf ]]; then
  if [[ ! -d $tools/autoconf-2.69 ]]; then tar -xJf "$archive" -C "$tools"; fi
  (cd "$tools/autoconf-2.69" && ./configure --prefix="$tools/install" && make -j"$jobs" && make install)
fi
if [[ ! -f $runtime/configure-inputs.txt ]]; then
  (cd "$source/libstdc++-v3" && "$tools/install/bin/autoconf")
  printf '%s %s\n' "$patch_digest" "$autoconf_sha" > "$runtime/configure-inputs.txt"
fi
if [[ ${1:-} == --prepare ]]; then
  printf 'Prepared isolated libstdc++ source: %s\n' "$source"
  exit 0
fi
[[ $# == 0 ]] || { echo 'Usage: build-libstdcxx.sh [--prepare]' >&2; exit 2; }
for tool in cc1 cc1plus xgcc; do test -x "$work/gcc-native/gcc/$tool"; done
test -x "$work/wabt-native/wat2wasm"
test -x "$sdk/bin/wasm-ld"
builtins="$sdk/lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a"
test -s "$builtins"
sysroot="$sdk/share/wasi-sysroot"
test -s "$sysroot/lib/wasm32-wasi/crt1-command.o"
mkdir -p "$runtime/driver/include" "$runtime/build" "$runtime/install"
# Port only the target libc header. Preserve the SDK and never erase TLS keywords
# in user source or define _Thread_local globally.
mkdir -p "$runtime/target-headers/include/wasm32-wasi"
cp -p "$sysroot/include/wasm32-wasi/__errno.h" "$runtime/target-headers/include/wasm32-wasi/__errno.h"
patch --batch --forward -d "$runtime/target-headers" -p1 < "$errno_patch"
# all-gcc does not perform libgcc's install-unwind_h-forbuild step. Use that
# component's real public declarations; this does not provide an unwinder.
cp -p "$source/libgcc/unwind-generic.h" "$runtime/driver/include/unwind.h"
cat > "$runtime/driver/runtime.specs" <<EOF
*startfile:
$sysroot/lib/wasm32-wasi/crt1-command.o

*lib:
-lm -lc

*libgcc:
$builtins

*link:
%{!o:-o a.out} --fatal-warnings -L$sysroot/lib/wasm32-wasi -e _start

*cc1plus:

EOF
python3 - "$runtime" "$work" "$sdk" <<'PY'
import pathlib, shlex, sys
runtime, work, sdk = map(pathlib.Path, sys.argv[1:])
driver = runtime / 'driver'
commands = {
    'gcc': [str(work/'gcc-native/gcc/xgcc'), '-B'+str(driver)+'/', '-B'+str(work/'gcc-native/gcc')+'/',
            '-specs='+str(driver/'runtime.specs'), '--sysroot='+str(sdk/'share/wasi-sysroot'),
            '-D__GCC_WASI_SINGLE_THREAD__=1',
            '-isystem', str(runtime/'target-headers/include/wasm32-wasi'),
            '-isystem', str(sdk/'share/wasi-sysroot/include/wasm32-wasi'),
            '-isystem', str(driver/'include')],
    'as': [str(work/'wabt-native/wat2wasm')],
    'ld': [str(sdk/'bin/wasm-ld')],
    'collect-ld': [str(sdk/'bin/wasm-ld')],
    'nm': [str(sdk/'bin/llvm-nm')],
}
for name, command in commands.items():
    path = driver/name
    path.write_text('#!/usr/bin/env bash\nset -euo pipefail\nexec '+shlex.join(command)+' "$@"\n')
    path.chmod(0o755)
cxx = driver/'g++'
if not cxx.exists(): cxx.symlink_to('gcc')
PY
python3 - "$runtime" "$work" <<'PY'
import hashlib, json, pathlib, sys
runtime, work = map(pathlib.Path, sys.argv[1:])
identity = {tool: hashlib.sha256((work/'gcc-native/gcc'/tool).read_bytes()).hexdigest() for tool in ['cc1','cc1plus','xgcc']}
file = runtime/'compiler-inputs.json'
if file.exists() and json.loads(file.read_text()) != identity:
    raise SystemExit('GCC compiler changed; choose a new GCC_LIBSTDCXX_WORK_DIR')
file.write_text(json.dumps(identity, indent=2)+'\n')
PY
export CC="$runtime/driver/gcc" CXX="$runtime/driver/g++"
export AR="$sdk/bin/llvm-ar" RANLIB="$sdk/bin/llvm-ranlib" NM="$sdk/bin/llvm-nm"
export AS="$runtime/driver/as" LD="$runtime/driver/ld"
export CFLAGS='-O0' CXXFLAGS='-O0 -fno-exceptions -fno-rtti -fuse-cxa-atexit -fno-threadsafe-statics'
export MAKEINFO=true
build_triple=$("$source/config.guess")
cd "$runtime/build"
if [[ ! -f Makefile ]]; then
  "$source/libstdc++-v3/configure" --build="$build_triple" --host=wasm32-wasi \
    --prefix="$runtime/install" --libdir="$runtime/install/lib" \
    --with-gxx-include-dir="$runtime/install/include/c++/17.0.0" \
    --disable-shared --disable-multilib --disable-nls --disable-symvers \
    --disable-libstdcxx-pch --disable-libstdcxx-threads --disable-libstdcxx-backtrace \
    --disable-libstdcxx-filesystem-ts --disable-libstdcxx-time --disable-libstdcxx-verbose \
    --enable-libstdcxx-dual-abi --with-default-libstdcxx-abi=new \
    --disable-libstdcxx-visibility --disable-werror \
    --enable-clocale=generic --enable-cstdio=stdio
fi
make -j"$jobs" all MAKEINFO=true
make install MAKEINFO=true
test -s "$runtime/install/lib/libstdc++.a"
test -s "$runtime/install/lib/libsupc++.a"
python3 - "$runtime" "$work" "$recipe" <<'PY'
import hashlib, json, pathlib, subprocess, sys
runtime, work, recipe = map(pathlib.Path, sys.argv[1:])
def identity(path):
    data=path.read_bytes(); return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
compiler = {tool: hashlib.sha256((work/'gcc-native/gcc'/tool).read_bytes()).hexdigest() for tool in ['cc1','cc1plus','xgcc']}
if compiler != json.loads((runtime/'compiler-inputs.json').read_text()):
    raise SystemExit('GCC compiler changed during libstdc++ build; result is unqualified')
gcc_source = json.loads(subprocess.check_output(['python3', str(recipe/'prepare-source.py'), '--source', str(work/'gcc')], text=True))
if gcc_source != json.loads((runtime/'gcc-source.json').read_text()):
    raise SystemExit('GCC source inputs changed during runtime build')
receipt = {'schemaVersion': 1, 'status': 'built-unverified', 'target': 'wasm32-wasi',
    'gccCommit': json.loads((recipe/'sources.lock.json').read_text())['gcc']['commit'],
    'recipe': identity(recipe/'build-libstdcxx.sh'),
    'patch': identity(recipe/'patches/libstdcxx-wasi-config.patch'),
    'errnoPatch': identity(recipe/'patches/wasi-libc-errno.patch'),
    'errnoHeader': identity(runtime/'target-headers/include/wasm32-wasi/__errno.h'),
    'nativeCompiler': compiler, 'gccSource': gcc_source,
    'configure': identity(runtime/'source/libstdc++-v3/configure'),
    'libraries': {name: identity(runtime/'install/lib'/name) for name in ['libstdc++.a', 'libsupc++.a']},
    'exceptions': False, 'rtti': False, 'threads': False, 'timezoneDatabase': False, 'debugger': False, 'stdModules': False}
(runtime/'build.json').write_text(json.dumps(receipt, indent=2)+'\n')
PY
