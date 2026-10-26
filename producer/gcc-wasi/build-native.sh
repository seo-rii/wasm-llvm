#!/usr/bin/env bash
# Real GCC C/C++ front ends and the experimental GCC RTL WebAssembly backend.
set -euo pipefail
recipe=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=${GCC_WASI_WORK_DIR:?Set an isolated GCC_WASI_WORK_DIR}
sdk=${WASI_SDK_PATH:?Set WASI_SDK_PATH to the pinned wasi-sdk-33.0}
jobs=${GCC_WASI_JOBS:-2}
[[ $jobs =~ ^[1-9][0-9]*$ ]] || { echo 'GCC_WASI_JOBS must be positive' >&2; exit 2; }
mkdir -p "$work"
work=$(realpath "$work")
sdk=$(realpath "$sdk")
revision=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["gcc"]["commit"])' "$recipe/sources.lock.json")
if [[ ! -d $work/gcc/.git ]]; then
  git init "$work/gcc"
  git -C "$work/gcc" remote add origin https://forge.sourceware.org/feedable/gcc-TEST.git
  git -C "$work/gcc" fetch --depth 1 origin "$revision"
  git -C "$work/gcc" checkout --detach FETCH_HEAD
fi
[[ $(git -C "$work/gcc" rev-parse HEAD) == "$revision" ]] || { echo 'GCC source revision mismatch' >&2; exit 2; }
python3 "$recipe/prepare-source.py" --source "$work/gcc" --apply > "$work/gcc-source.json"
[[ $(cat "$work/gcc/gcc/BASE-VER") == 17.0.0 ]] || exit 2
"$sdk/bin/wasm-ld" --version | grep -F 'LLD 22.1.0'
for tool in make gcc g++ bison flex; do command -v "$tool" >/dev/null; done
mkdir -p "$work/gcc-native"
cd "$work/gcc-native"
if [[ ! -f Makefile ]]; then
  "$work/gcc/configure" --target=wasm32-wasi --prefix="$work/native-install" \
    --with-sysroot="$sdk/share/wasi-sysroot" --enable-languages=c,c++ \
    --disable-bootstrap --disable-analyzer --disable-multilib --disable-nls \
    --disable-shared --disable-threads --disable-libstdcxx --disable-libsanitizer \
    --disable-libssp --disable-libquadmath --disable-libgomp --disable-libatomic \
    --disable-libvtv --disable-libcc1 --disable-libitm --disable-lto --disable-plugin \
    --disable-werror --enable-checking=release --disable-fixincludes --without-headers \
    CFLAGS='-O1 -g0' CXXFLAGS='-O1 -g0' MAKEINFO=true
fi
# The draft target's driver injects -stdlib=libc++, which this pinned cc1plus
# does not recognize. Runtime/header choice belongs to our explicit pipeline.
# Clear that driver-only spec for the build's real C/C++ frontend smoke tests.
printf '*cc1plus:\n\n' > "$work/native-driver.specs"
set +e
make -j"$jobs" all-gcc MAKEINFO=true
bootstrap_status=$?
set -e
printf '{"initialAllGccExitCode":%s}\n' "$bootstrap_status" > "$work/native-bootstrap.json"
# The top-level Canadian-cross makefile overrides this variable in its
# recursive invocation. Apply it directly at the GCC self-test boundary.
make -j"$jobs" -C gcc cc1 cc1plus MAKEINFO=true
make -C gcc selftest MAKEINFO=true \
  GCC_FOR_SELFTESTS="$work/gcc-native/gcc/xgcc -B$work/gcc-native/gcc/ -specs=$work/native-driver.specs"
make -j"$jobs" all-gcc MAKEINFO=true
test -x gcc/cc1
test -x gcc/cc1plus
make -C gcc stmp-int-hdrs STMP_FIXINC= LIMITS_H_TEST=true MAKEINFO=true
gcc/xgcc -B gcc -dumpmachine
gcc/cc1 --version
gcc/cc1plus --version
python3 - "$recipe" "$work" <<'PY'
import hashlib, json, pathlib, subprocess, sys
recipe, work = map(pathlib.Path, sys.argv[1:])
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
receipt = {
  'schemaVersion': 1, 'host': 'native', 'target': 'wasm32-wasi',
  'sourceLockSha256': digest(recipe / 'sources.lock.json'),
  'recipeSha256': digest(recipe / 'build-native.sh'),
  'driverSpecsSha256': digest(work / 'native-driver.specs'),
  'gccCommit': subprocess.check_output(['git', '-C', str(work / 'gcc'), 'rev-parse', 'HEAD'], text=True).strip(),
  'gccSource': json.loads((work / 'gcc-source.json').read_text()),
  'tools': {name: {'sha256': digest(work / 'gcc-native/gcc' / name)} for name in ['cc1', 'cc1plus', 'xgcc']},
}
(work / 'native-build.json').write_text(json.dumps(receipt, indent=2) + '\n')
PY
