#!/usr/bin/env bash
# GCC emits WAT with linking annotations. This pinned WABT fork assembles it;
# neither this assembler nor Emscripten compiles the user's C/C++ source.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository=$(cd -- "$script_dir/../.." && pwd)
work=${GCC_WASI_WORK_DIR:-"$repository/out/gcc-wasi-work"}
jobs=${GCC_WASI_WABT_JOBS:-2}
mode=${1:-all}
revision=651c9ffbce3d0525d2d1324fab79160e5fcf8173
repository_url=https://github.com/feedab1e/wabt.git
[[ $jobs =~ ^[1-9][0-9]*$ ]] || { echo 'GCC_WASI_WABT_JOBS must be positive' >&2; exit 2; }
case "$mode" in native|browser|all) ;; *) echo 'Usage: build-wabt.sh [native|browser|all]' >&2; exit 2;; esac
for tool in git cmake python3; do command -v "$tool" >/dev/null; done
mkdir -p "$work"
work=$(realpath "$work")
source_dir="$work/wabt-source"
native_dir="$work/wabt-native"
browser_dir="$work/wabt-browser"

if [[ ! -e $source_dir ]]; then
  git init -q "$source_dir"
  git -C "$source_dir" remote add origin "$repository_url"
  git -C "$source_dir" fetch --depth=1 origin "$revision"
  git -C "$source_dir" checkout --detach FETCH_HEAD
fi
[[ $(git -C "$source_dir" rev-parse HEAD) == "$revision" ]] || {
  echo "Unexpected WABT revision in $source_dir" >&2; exit 2;
}
git -C "$source_dir" diff --quiet
git -C "$source_dir" diff --cached --quiet
# Pinned gitlink, needed by the browser build, without downloading the test suite.
git -C "$source_dir" submodule update --init --depth=1 third_party/picosha2

common_options=(
  -DBUILD_TESTS=OFF -DBUILD_LIBWASM=OFF -DWITH_WASI=OFF
  -DWITH_EXCEPTIONS=OFF -DUSE_INTERNAL_SHA256=ON -DWABT_INSTALL_RULES=OFF
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS_RELEASE=-O2\ -DNDEBUG
  -DCMAKE_CXX_FLAGS_RELEASE=-O2\ -DNDEBUG
)
if [[ $mode == native || $mode == all ]]; then
  cmake -S "$source_dir" -B "$native_dir" "${common_options[@]}" -DBUILD_TOOLS=ON
  cmake --build "$native_dir" --target wat2wasm wasm-objdump wasm-validate --parallel "$jobs"
  "$native_dir/wat2wasm" --version
  python3 - "$source_dir" "$native_dir" "$revision" <<'PY'
import json, pathlib, subprocess, sys
source, output, revision = sys.argv[1:]
receipt = {
    "component": "wabt", "role": "wasm-object-assembler", "host": "native",
    "repository": "https://github.com/feedab1e/wabt.git", "commit": revision,
    "version": subprocess.check_output([str(pathlib.Path(output) / "wat2wasm"), "--version"], text=True).strip(),
    "license": "Apache-2.0", "assemblerArguments": ["-r", "--enable-annotations"],
    "submodules": subprocess.check_output(["git", "-C", source, "submodule", "status", "third_party/picosha2"], text=True).strip(),
}
pathlib.Path(output, "provenance.json").write_text(json.dumps(receipt, indent=2) + "\n")
PY
fi

if [[ $mode == browser || $mode == all ]]; then
  emsdk=${GCC_WASI_EMSDK:?Set GCC_WASI_EMSDK to the installed Emscripten 6.0.0 SDK}
  # Only read the SDK; caches and ports are isolated from other build jobs.
  # shellcheck disable=SC1091
  source "$emsdk/emsdk_env.sh"
  export EM_CACHE="$browser_dir/emscripten-cache" EM_PORTS="$browser_dir/emscripten-ports"
  export EMCC_CORES="$jobs"
  [[ $(emcc --version | head -1) == *'6.0.0'* ]] || {
    echo 'The pinned browser assembler recipe requires Emscripten 6.0.0' >&2; exit 2;
  }
  # WABT's upstream CLI target enables NODERAWFS. Build its library, then link
  # the unmodified wat2wasm main with MEMFS so the same module works in Workers.
  emcmake cmake -S "$source_dir" -B "$browser_dir/build" "${common_options[@]}" -DBUILD_TOOLS=OFF
  cmake --build "$browser_dir/build" --target wabt --parallel "$jobs"
  em++ -std=c++17 -Os -g0 -fno-exceptions \
    -I"$source_dir/include" -I"$browser_dir/build/include" \
    "$source_dir/src/tools/wat2wasm.cc" "$browser_dir/build/libwabt.a" \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createModule \
    -sENVIRONMENT=worker,node -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
    -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain,HEAPU8 \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=2GB \
    -sSTACK_SIZE=16MB -o "$browser_dir/as.mjs"
  install -m644 "$source_dir/LICENSE" "$browser_dir/LICENSE.wabt"
  install -m644 "$source_dir/third_party/picosha2/LICENSE" "$browser_dir/LICENSE.picosha2"
  install -m644 "$emsdk/upstream/emscripten/LICENSE" "$browser_dir/LICENSE.emscripten"
  install -m644 "$emsdk/upstream/emscripten/system/lib/libc/musl/COPYRIGHT" "$browser_dir/LICENSE.musl"
  for component in libcxx libcxxabi compiler-rt; do
    install -m644 "$emsdk/upstream/emscripten/system/lib/$component/LICENSE.TXT" "$browser_dir/LICENSE.$component"
  done
  python3 - "$source_dir" "$browser_dir" "$revision" <<'PY'
import hashlib, json, pathlib, subprocess, sys
source, output, revision = sys.argv[1:]
receipt = {
    "component": "wabt", "role": "wasm-object-assembler", "host": "wasm32-emscripten",
    "repository": "https://github.com/feedab1e/wabt.git", "commit": revision,
    "license": "Apache-2.0", "assemblerArguments": ["-r", "--enable-annotations"],
    "emscripten": subprocess.check_output(["emcc", "--version"], text=True).splitlines()[0],
    "submodules": subprocess.check_output(["git", "-C", source, "submodule", "status", "third_party/picosha2"], text=True).strip(),
    "files": {},
}
for name in ("as.mjs", "as.wasm"):
    data = pathlib.Path(output, name).read_bytes()
    receipt["files"][name] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
pathlib.Path(output, "provenance.json").write_text(json.dumps(receipt, indent=2) + "\n")
PY
fi
