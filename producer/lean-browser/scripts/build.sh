#!/usr/bin/env bash
# Build the upstream Lean 4 frontend/interpreter as a wasm32 Emscripten module and compile the
# Init library with that module. Usage: build.sh [stage...]
#   stages: fetch emsdk runtime cgen objects link oleans (default: all, in order)
# Environment:
#   WASM_LLVM_LEAN_WORK_DIR  work directory (default: out/lean-browser-work)
#   WASM_LLVM_LEAN_JOBS      parallel jobs, at most 3 (default: 3)
#   EMSDK                    optional existing emsdk checkout; must report Emscripten 6.0.0
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCER="$(dirname "$HERE")"
REPO="$(cd "$PRODUCER/../.." && pwd)"
MANIFEST="$PRODUCER/manifest.json"
WORK="$(realpath -m "${WASM_LLVM_LEAN_WORK_DIR:-$REPO/out/lean-browser-work}")"
JOBS="${WASM_LLVM_LEAN_JOBS:-3}"
if ! [[ "$JOBS" =~ ^[1-3]$ ]]; then echo "WASM_LLVM_LEAN_JOBS must be 1, 2, or 3" >&2; exit 2; fi

pin() { node -e 'const m=require(process.argv[1]);let v=m;for(const k of process.argv[2].split("."))v=v[k];process.stdout.write(String(v))' "$MANIFEST" "$1"; }
LEAN_COMMIT="$(pin sources.lean4.commit)"
LEAN_VERSION="$(pin sources.lean4.version)"
BOOT_URL="$(pin bootstrap.url)"
BOOT_SHA="$(pin bootstrap.sha256)"
EMSDK_COMMIT="$(pin sources.emsdk.commit)"
EMSDK_VERSION="$(pin sources.emsdk.version)"
PATCH="$PRODUCER/$(pin patches.0.path)"
PATCH_SHA="$(pin patches.0.sha256)"

SRC="$WORK/lean4"
BOOT="$WORK/lean-$LEAN_VERSION-linux"
BUILD="$WORK/build-wasm"
CGEN="$WORK/cgen"
OBJ="$WORK/obj"
DIST="$WORK/dist"
OLEAN="$WORK/olean32"
mkdir -p "$WORK"

stage_fetch() {
	echo "$PATCH_SHA  $PATCH" | sha256sum -c --quiet -
	if [ ! -d "$SRC/.git" ]; then
		git init -q "$SRC"
		git -C "$SRC" remote add origin "$(pin sources.lean4.repository)"
		git -C "$SRC" fetch -q --depth 1 origin "$LEAN_COMMIT"
		git -C "$SRC" checkout -q FETCH_HEAD
	fi
	[ "$(git -C "$SRC" rev-parse HEAD)" = "$LEAN_COMMIT" ] || { echo "lean4 source is not at $LEAN_COMMIT" >&2; exit 1; }
	if git -C "$SRC" diff --quiet; then
		git -C "$SRC" apply "$PATCH"
	else
		# A reused checkout must carry exactly the pinned patch and nothing else.
		[ "$(git -C "$SRC" diff | sha256sum | cut -d' ' -f1)" = "$PATCH_SHA" ] || { echo "lean4 checkout has unexpected local changes" >&2; exit 1; }
	fi
	[ -z "$(git -C "$SRC" ls-files --others --exclude-standard)" ] || { echo "lean4 checkout has untracked files" >&2; exit 1; }
	local tarball="$WORK/$(basename "$BOOT_URL")"
	if [ ! -x "$BOOT/bin/lean" ]; then
		if [ ! -f "$tarball" ]; then
			curl -fL --retry 3 -o "$tarball.part" "$BOOT_URL"
			mv "$tarball.part" "$tarball"
		fi
		echo "$BOOT_SHA  $tarball" | sha256sum -c --quiet -
		zstd -dc "$tarball" | tar -x -C "$WORK"
		rm -f "$tarball"
	fi
	"$BOOT/bin/lean" --version | grep -q "version $LEAN_VERSION," || { echo "bootstrap is not Lean $LEAN_VERSION" >&2; exit 1; }
	"$BOOT/bin/lean" --githash | grep -qx "$LEAN_COMMIT" || { echo "bootstrap githash differs from the source pin" >&2; exit 1; }
}

stage_emsdk() {
	if [ -z "${EMSDK:-}" ]; then
		EMSDK="$WORK/emsdk"
		if [ ! -d "$EMSDK/.git" ]; then
			git init -q "$EMSDK"
			git -C "$EMSDK" remote add origin "$(pin sources.emsdk.repository)"
			git -C "$EMSDK" fetch -q --depth 1 origin "$EMSDK_COMMIT"
			git -C "$EMSDK" checkout -q FETCH_HEAD
		fi
		[ -x "$EMSDK/upstream/emscripten/emcc" ] || { "$EMSDK/emsdk" install "$EMSDK_VERSION" && "$EMSDK/emsdk" activate "$EMSDK_VERSION"; }
	fi
	echo "$EMSDK" > "$WORK/emsdk.path"
}

load_emsdk() {
	EMSDK="$(cat "$WORK/emsdk.path")"
	export EMSDK EM_CONFIG="$EMSDK/.emscripten" EM_CACHE="$WORK/emcache"
	export PATH="$EMSDK/upstream/emscripten:$EMSDK/upstream/bin:$PATH"
	tr -d '"\n' < "$EMSDK/upstream/emscripten/emscripten-version.txt" | grep -qx "$EMSDK_VERSION" || { echo "emsdk is not Emscripten $EMSDK_VERSION" >&2; exit 1; }
}

stage_runtime() {
	load_emsdk
	emcmake cmake -S "$SRC/src" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release -DSTAGE=1 -DPREV_STAGE="$BOOT" \
		-DUSE_GMP=OFF -DUSE_MIMALLOC=OFF -DLLVM=OFF > "$WORK/configure.log"
	make -C "$BUILD" -j"$JOBS" leanrt leancpp leanshell leanmain libuv
}

stage_cgen() {
	# Module lists come from the pinned release so the browser binary contains exactly its compiler.
	(cd "$BOOT/lib/lean" && find Init Std Lean -name '*.olean' | sed 's/\.olean$//'; printf '%s\n' Init Std Lean) | LC_ALL=C sort > "$WORK/modules.txt"
	export BOOT CGEN
	gen() {
		local out="$CGEN/$1.c"
		[ -s "$out" ] && return 0
		mkdir -p "$(dirname "$out")"
		LEAN_PATH="$BOOT/lib/lean" "$BOOT/bin/lean" -j1 -R . -Dinterpreter.prefer_native=false -Dpp.rawOnError=true \
			-c "$out.tmp" "$1.lean" > /dev/null || { echo "cgen failed: $1" >&2; return 1; }
		mv "$out.tmp" "$out"
	}
	export -f gen
	(cd "$SRC/src" && xargs -a "$WORK/modules.txt" -P "$JOBS" -I{} bash -c 'gen "$@"' _ {})
}

stage_objects() {
	load_emsdk
	export CGEN OBJ BUILD
	cc1() {
		local rel="${1#$CGEN/}" o
		o="$OBJ/${rel%.c}.o"
		[ -s "$o" ] && [ "$o" -nt "$1" ] && return 0
		mkdir -p "$(dirname "$o")"
		emcc -c -O2 -DNDEBUG -DLEAN_EMSCRIPTEN -pthread -fwasm-exceptions -ffp-contract=off \
			-fdata-sections -ffunction-sections -w -I"$BUILD/include" "$1" -o "$o.tmp" || { echo "emcc failed: $1" >&2; return 1; }
		mv "$o.tmp" "$o"
	}
	export -f cc1
	find "$CGEN" -name '*.c' | LC_ALL=C sort | xargs -P "$JOBS" -I{} bash -c 'cc1 "$@"' _ {}
}

stage_link() {
	load_emsdk
	mkdir -p "$DIST"
	python3 "$HERE/gen-symtab.py" "$CGEN" "$OBJ/symtab.c"
	emcc -c -O2 -DNDEBUG -DLEAN_EMSCRIPTEN -pthread -w -I"$BUILD/include" "$OBJ/symtab.c" -o "$OBJ/symtab.o"
	find "$OBJ" -name '*.o' ! -name symtab.o | LC_ALL=C sort > "$OBJ/objs.rsp"
	# Undefined symbols are an error: every Lean `@[extern]` reachable from the frontend must exist.
	emcc -O2 -pthread -fwasm-exceptions @"$OBJ/objs.rsp" "$OBJ/symtab.o" \
		"$BUILD/lib/temp/libleanmain.a" "$BUILD/lib/temp/libleanshell.a" \
		"$BUILD/lib/lean/libleancpp.a" "$BUILD/lib/lean/libleanrt.a" "$BUILD/libuv/src/libuv/libuv.a" \
		-Wl,--gc-sections \
		-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456 -sMAXIMUM_MEMORY=4294967296 \
		-sSTACK_SIZE=16777216 -sDEFAULT_PTHREAD_STACK_SIZE=8388608 -sPTHREAD_POOL_SIZE=4 \
		-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLean -sENVIRONMENT=web,worker,node \
		-sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -lnodefs.js \
		-sEXPORTED_RUNTIME_METHODS=FS,callMain,ENV,NODEFS \
		-o "$DIST/lean.mjs"
}

stage_oleans() {
	# .olean files are pointer-size specific, so Init is compiled again by the wasm32 Lean itself.
	(cd "$SRC/src" && grep -E '^Init(/|$)' "$WORK/modules.txt" | while read -r m; do
		printf '%s: %s\n' "$m" "$(LEAN_PATH="$BOOT/lib/lean" "$BOOT/bin/lean" --deps "$m.lean" | sed "s#^$BOOT/lib/lean/##; s#\.olean\$##" | tr '\n' ' ')"
	done) > "$WORK/deps.txt"
	mkdir -p "$OLEAN"
	node "$HERE/build-oleans.mjs" "$DIST/lean.mjs" "$WORK" "$SRC/src" "$OLEAN" "$JOBS" Init
}

STAGES=("$@")
[ ${#STAGES[@]} -gt 0 ] || STAGES=(fetch emsdk runtime cgen objects link oleans)
for s in "${STAGES[@]}"; do
	echo "== lean-browser stage: $s"
	"stage_$s"
done
