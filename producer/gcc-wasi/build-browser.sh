#!/usr/bin/env bash
# Canadian cross: native generators -> Emscripten GCC host -> WASI output.
set -euo pipefail
recipe=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=${GCC_WASI_WORK_DIR:?Set GCC_WASI_WORK_DIR}
sdk=${EMSDK_PATH:?Set EMSDK_PATH}
jobs=${GCC_WASI_JOBS:-2}
[[ $jobs =~ ^[1-9][0-9]*$ ]] || exit 2
work=$(realpath "$work")
test -s "$work/native-build.json"
test -s "$work/native-qualification.json"
python3 "$recipe/prepare-source.py" --source "$work/gcc" > "$work/gcc-browser-source.json"
python3 - "$work" "$recipe" <<'PY'
import hashlib,json,pathlib,subprocess,sys
work,recipe=map(pathlib.Path,sys.argv[1:])
lock=json.loads((recipe/'sources.lock.json').read_text())
rev=subprocess.check_output(['git','-C',str(work/'gcc'),'rev-parse','HEAD'],text=True).strip()
if rev!=lock['gcc']['commit']: raise SystemExit('GCC source revision mismatch')
source=json.loads((work/'gcc-browser-source.json').read_text())
native=json.loads((work/'native-build.json').read_text())
if native.get('gccSource')!=source: raise SystemExit('Native and browser GCC source/patches must match')
if native.get('driverSpecsSha256')!=hashlib.sha256((work/'native-driver.specs').read_bytes()).hexdigest():
    raise SystemExit('Native driver specs differ from the qualified build')
qualification=json.loads((work/'native-qualification.json').read_text())
if qualification.get('status')!='passed': raise SystemExit('Native compile/link/execute qualification must pass first')
if qualification.get('gccCommit')!=rev: raise SystemExit('Native qualification covers another compiler')
if qualification.get('gccSource')!=source: raise SystemExit('Native qualification covers different GCC patches')
if qualification.get('buildReceiptSha256')!=hashlib.sha256((work/'native-build.json').read_bytes()).hexdigest():
    raise SystemExit('Native qualification covers another compiler build')
PY
source "$sdk/emsdk_env.sh"
mkdir -p "$work/emscripten-cache" "$work/emscripten-ports"
# Emscripten makes system-library source paths relative to EM_CACHE before
# entering that directory. A symlink cache must use its physical path so the
# relative paths still resolve when subprocesses enter the cache's real cwd.
export EM_CACHE="$(realpath "$work/emscripten-cache")"
export EM_PORTS="$(realpath "$work/emscripten-ports")"
emcc --version | head -1 | grep -F '6.0.0'
python3 - "$sdk" "$recipe" <<'PY'
import json,pathlib,subprocess,sys
sdk,recipe=map(pathlib.Path,sys.argv[1:]); pin=json.loads((recipe/'sources.lock.json').read_text())['emsdk']
revision=subprocess.check_output(['git','-C',str(sdk),'rev-parse','HEAD'],text=True).strip()
if revision!=pin['commit']: raise SystemExit('emsdk source revision mismatch')
version=subprocess.check_output([str(sdk/'upstream/emscripten/emcc'),'--version'],text=True)
if pin['emscriptenCommit'] not in version: raise SystemExit('Emscripten compiler revision mismatch')
PY
deps="$work/host-libraries"
for lib in gmp mpfr mpc; do test -s "$deps/lib/lib$lib.a"; done
export CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ HOST_CC=gcc HOST_CXX=g++ BUILD_CC=gcc
export CFLAGS_FOR_BUILD='-O2 -g0' CXXFLAGS_FOR_BUILD='-O2 -g0'
export CONFIG_SITE="$work/emscripten.config.site"
cat > "$CONFIG_SITE" <<'EOF'
am_cv_ar_has_plugin=no
am_cv_ranlib_has_plugin=no
case "${host_alias:-}" in
  wasm32-*-emscripten) ac_cv_func__Unwind_Backtrace=no ;;
esac
EOF
build_triple=$("$work/gcc/config.guess")
# Use the native build's qualified driver specs at target self-test boundaries.
# The draft driver's unsupported -stdlib=libc++ option must not reach cc1plus.
native_driver="$work/gcc-native/gcc/xgcc -B$work/gcc-native/gcc/ -specs=$work/native-driver.specs"
hostflags='-Os -g0 -DHAVE_PSIGNAL=1 -DELIDE_CODE'
moduleflags='-Os -g0 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createModule -sENVIRONMENT=worker,node -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain,HEAPU8 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=128MB -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=16MB -sUSE_ZLIB=1'
mkdir -p "$work/gcc-browser"
cd "$work/gcc-browser"
if [[ -f Makefile ]]; then
  python3 - "$PWD" <<'PY'
import pathlib,shlex,subprocess,sys
build=pathlib.Path(sys.argv[1])
args=shlex.split(subprocess.check_output([str(build/'config.status'),'--config'],text=True))
if '--disable-gcov' not in args:
    raise SystemExit('Existing Wasm-host build enables unsupported gcov utilities; use a fresh GCC_WASI_WORK_DIR')
PY
fi
if [[ ! -f Makefile ]]; then
  emconfigure "$work/gcc/configure" --build="$build_triple" --host=wasm32-unknown-emscripten \
    --target=wasm32-wasi --prefix=/opt/gcc-wasi --with-sysroot=/sysroot \
    --enable-languages=c,c++ --with-gmp="$deps" --with-mpfr="$deps" --with-mpc="$deps" \
    --disable-bootstrap --disable-analyzer --disable-shared --disable-threads --disable-nls \
    --disable-multilib --disable-libssp --disable-libada --disable-libquadmath \
    --disable-libgomp --disable-libvtv --disable-libstdcxx --disable-libsanitizer \
    --disable-libatomic --disable-libcc1 --disable-libitm --disable-lto --disable-plugin \
    --disable-werror --enable-checking=release --disable-fixincludes --disable-gcov --without-headers \
    CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ CFLAGS="$hostflags" CXXFLAGS="$hostflags" \
    GCC_FOR_TARGET="$native_driver" MAKEINFO=true
fi
# Re-run target option discovery when reusing a build predating new .opt files.
# config.status preserves the original Canadian-cross configure arguments.
if [[ -f gcc/config.status ]]; then
  (cd gcc && emconfigure ./config.status --recheck && ./config.status)
fi
# Build native generators and host support libraries through the normal graph.
# This browser-frontend profile explicitly excludes gcov host utilities: their
# filesystem traversal is not provided by this producer. No failed all-gcc
# build is accepted as successful frontend preparation.
set +e
emmake make -j"$jobs" all-gcc CFLAGS="$hostflags" CXXFLAGS="$hostflags" \
  GCC_FOR_TARGET="$native_driver" MAKEINFO=true
bootstrap_status=$?
set -e
printf '{"allGccBootstrapExitCode":%s,"gcovHostTools":"disabled","profile":"browser-frontends"}\n' "$bootstrap_status" > "$work/browser-bootstrap.json"
if [[ $bootstrap_status -ne 0 ]]; then
  echo 'Wasm-host all-gcc preparation failed; frontend packaging is aborted' >&2
  exit "$bootstrap_status"
fi
rm -f gcc/cc1 gcc/cc1plus
emmake make -j"$jobs" -C gcc cc1 cc1plus CFLAGS="$hostflags" CXXFLAGS="$hostflags" \
  LDFLAGS="$moduleflags" MAKEINFO=true
out="$work/browser-compiler"
mkdir "$out"
for tool in cc1 cc1plus; do
  install -m644 "gcc/$tool" "$out/$tool.mjs"
  install -m644 "gcc/$tool.wasm" "$out/$tool.wasm"
done
# These are target headers from the identical native GCC source/patch identity.
# Generating them with the Canadian-cross driver would execute its Wasm xgcc
# during the build. Browser consumers call cc1/cc1plus directly instead.
cp -a "$work/gcc-native/gcc/include" "$out/resource-include"
mkdir "$out/licenses"
for notice in COPYING COPYING3 COPYING.RUNTIME; do
  install -m644 "$work/gcc/$notice" "$out/licenses/gcc-$notice"
done
for component in gmp-6.3.0 mpfr-4.2.1 mpc-1.3.1; do
  mkdir "$out/licenses/$component"
  for notice in "$work/host-sources/$component"/COPYING*; do
    install -m644 "$notice" "$out/licenses/$component/$(basename "$notice")"
  done
done
install -m644 "$sdk/upstream/emscripten/LICENSE" "$out/licenses/emscripten-LICENSE"
python3 - "$work" "$recipe" <<'PY'
import hashlib,json,pathlib,sys
work,recipe=map(pathlib.Path,sys.argv[1:]); out=work/'browser-compiler'
def identity(p):
    data=p.read_bytes(); return {'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
files={str(p.relative_to(out)):identity(p) for p in sorted(out.rglob('*')) if p.is_file()}
receipt={'schemaVersion':1,'kind':'gcc-wasi-browser-build','host':'wasm32-emscripten',
 'target':'wasm32-wasi','gccCommit':json.loads((recipe/'sources.lock.json').read_text())['gcc']['commit'],
 'hostUtilityProfile':{'name':'browser-frontends','gcov':False,'gcovDump':False,'gcovTool':False},
 'bootstrap':json.loads((work/'browser-bootstrap.json').read_text()),
 'gccSource':json.loads((work/'gcc-browser-source.json').read_text()),
 'sourceLock':identity(recipe/'sources.lock.json'),'recipe':identity(recipe/'build-browser.sh'),
 'hostDependencies':{name:identity(work/'host-libraries/lib'/('lib'+name+'.a')) for name in ['gmp','mpfr','mpc']},
 'nativeQualification':identity(work/'native-qualification.json'),'files':files}
receipt['nativeDriverSpecs']=identity(work/'native-driver.specs')
(out/'compiler-build.json').write_text(json.dumps(receipt,indent=2)+'\n')
PY
