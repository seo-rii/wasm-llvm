#!/usr/bin/env bash
set -euo pipefail
recipe=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=${GCC_WASI_WORK_DIR:?Set GCC_WASI_WORK_DIR}
sdk=${EMSDK_PATH:?Set EMSDK_PATH to the pinned Emscripten 6.0.0 SDK}
jobs=${GCC_WASI_JOBS:-2}
[[ $jobs =~ ^[1-9][0-9]*$ ]] || exit 2
mkdir -p "$work"
work=$(realpath "$work")
# Source the explicitly selected SDK; never modify the shared SDK/cache.
source "$sdk/emsdk_env.sh"
export EM_CACHE="$work/emscripten-cache" EM_PORTS="$work/emscripten-ports"
emcc --version | head -1 | grep -F '6.0.0'
python3 - "$recipe/../gcc-browser/sources.lock.json" "$work" <<'PY'
import hashlib,json,pathlib,shutil,subprocess,sys,urllib.request
lock=json.load(open(sys.argv[1]))['sources']
work=pathlib.Path(sys.argv[2])
sources=work/'host-sources'; sources.mkdir(exist_ok=True)
downloads=work/'downloads'; downloads.mkdir(exist_ok=True)
for name in ['gmp','mpfr','mpc']:
    item=lock[name]; archive=downloads/item['url'].rsplit('/',1)[1]
    if not archive.exists():
        temp=archive.with_suffix('.partial')
        with urllib.request.urlopen(item['url'],timeout=120) as source, temp.open('wb') as dest:
            shutil.copyfileobj(source,dest)
        temp.rename(archive)
    with archive.open('rb') as f: actual=hashlib.file_digest(f,'sha256').hexdigest()
    if actual != item['sha256']: raise RuntimeError(f'Invalid {name} source digest')
    dest=sources/item['directory']; stamp=dest/'.source-sha256'
    if dest.exists():
        if not stamp.exists() or stamp.read_text().strip()!=actual: raise RuntimeError(f'Unknown source tree: {dest}')
    else:
        # Only exact, SHA-256 authenticated GNU source archives reach tar.
        subprocess.run(['tar', '-xf', str(archive), '-C', str(sources)], check=True)
        stamp.write_text(actual+'\n')
PY
deps="$work/host-libraries"
build_triple=$(gcc -dumpmachine)
host=wasm32-unknown-emscripten
mkdir -p "$deps"
for component in gmp-6.3.0 mpfr-4.2.1 mpc-1.3.1; do
  mkdir -p "$work/host-build/$component"
  cd "$work/host-build/$component"
  extra=()
  case "$component" in
    gmp-*) extra+=(--disable-assembly);;
    mpfr-*) extra+=(--with-gmp="$deps");;
    mpc-*) extra+=(--with-gmp="$deps" --with-mpfr="$deps");;
  esac
  if [[ ! -f Makefile ]]; then
    emconfigure "$work/host-sources/$component/configure" --build="$build_triple" \
      --host="$host" --prefix="$deps" --disable-shared --enable-static \
      "${extra[@]}" CC_FOR_BUILD=gcc CFLAGS='-Os -g0'
  fi
  emmake make -j"$jobs"
  emmake make install
done
