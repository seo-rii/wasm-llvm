#!/usr/bin/env python3
"""Prepare real pinned compiler sources for an official wasmJs compiler build attempt."""

import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "parser-probe"))
from prepare import read_regular, regular_path, sha256, write_new_bytes, write_new_json

COMMIT = "4d78aae1e337cd40f69baa865aed950fe807a775"
ROOT_TREE = "2be662d1ae06bfcf435efbe18191ba5e1e3f035e"
SOURCE = {"repository": "https://github.com/JetBrains/kotlin.git", "commit": COMMIT, "treeSha": ROOT_TREE}
MAX_FILE = 8 * 1024 * 1024
MAX_CLOSURE = 128 * 1024 * 1024

# Source roots are selected explicitly. This inventory deliberately does not
# carry JVM/native backends, Java frontend, IDE, daemon or CLI pipeline drivers.
GROUPS = {
    "tree-core.json": ("core", [
        "compiler.common", "compiler.common.web", "compiler.common.wasm", "compiler.common.js",
        "descriptors", "deserialization", "deserialization.common", "metadata", "names",
        "language.model", "language.targets", "language.version-settings", "util.runtime",
    ]),
    "tree-compiler_fir.json": ("compiler/fir", [
        "tree", "cones", "providers", "semantics", "resolve", "checkers",
        "checkers/checkers.wasm", "diagnostic-renderers", "fir-deserialization", "fir-serialization",
        "fir2ir", "raw-fir/raw-fir.common", "raw-fir/light-tree2fir", "raw-fir/mp-parsing2fir", "entrypoint",
    ]),
    "tree-compiler_ir.json": ("compiler/ir", [
        "ir.tree", "backend.common", "backend.js", "backend.wasm", "ir.inline", "ir.actualization",
        "serialization.common", "serialization.js", "ir.validation", "ir.psi2ir",
    ]),
    "tree-wasm.json": ("wasm", ["wasm.config", "wasm.frontend", "wasm.ir"]),
    "discovery-tree-js.json": ("js", [
        "js.ast", "js.config", "js.sourcemap", "typescript-export-model", "typescript-printer",
    ]),
}
DIRECT = [
    "compiler/frontend.common", "compiler/config", "compiler/container", "compiler/plugin-api",
    "compiler/resolution.common", "compiler/serialization.common", "compiler/util", "compiler/util-io",
    "compiler/util-klib", "compiler/util-klib-metadata", "compiler/arguments.common",
]
GENERATORS = {
    "compiler/fir/tree": "tree/tree-generator",
    "compiler/fir/checkers": "checkers/checkers-component-generator",
    "compiler/ir/ir.tree": "ir.tree/tree-generator",
}
EXCLUDED_ENTRYPOINT = {
    "FirJvmSessionFactory.kt", "FirJvmIncrementalCompilationSymbolProviders.kt", "FirNativeSessionFactory.kt",
    "FirMetadataSessionFactory.kt", "NativeForwardDeclarationsSymbolProvider.kt", "FirJsSessionFactory.kt",
}
REFERENCE_NAMES = {
    "WasmIrLoadingPipelinePhase.kt", "WasmIrLoweringPipelinePhase.kt", "WasmIrLinkingPipelinePhase.kt", "WasmOutputGenerationPipelinePhase.kt",
    "WebFrontendPipelinePhase.kt", "firUtils.kt", "CompilerConfigurationExtensions.kt",
    "FirSessionConstructionUtils.kt", "WebFir2IrPipelinePhase.kt", "WebKlibSerializationPipelinePhase.kt",
    "KotlinIr2WasmIrCompiler.kt", "WasmBackendIrGenerationPipelinePhase.kt", "WasmConfigurationUpdater.kt",
}


def tree_digest(entries):
    children = {}
    for item in entries:
        parent, _, name = item["path"].rpartition("/")
        children.setdefault(parent, []).append((name, item))
    computed = {}
    for directory in sorted(children, key=lambda p: (p.count("/"), len(p)), reverse=True):
        material = bytearray()
        for name, item in sorted(children[directory], key=lambda pair: pair[0] + ("/" if pair[1]["type"] == "tree" else "")):
            child = directory + "/" + name if directory else name
            if item["type"] == "tree" and child in computed and computed[child] != item["sha"]:
                raise ValueError("Cached subtree identity differs: " + child)
            material.extend(item["mode"].lstrip("0").encode() + b" " + name.encode() + b"\0" + bytes.fromhex(item["sha"]))
        computed[directory] = hashlib.sha1(b"tree " + str(len(material)).encode() + b"\0" + material).hexdigest()
    return computed[""]


def snapshot(cache, filename):
    value = json.loads(read_regular(cache / filename, 16 * 1024 * 1024))
    if value.get("truncated") or not value.get("tree"):
        raise ValueError("Incomplete cached Git tree: " + filename)
    if tree_digest(value["tree"]) != value["sha"]:
        raise ValueError("Cached Git tree SHA differs: " + filename)
    return value


def load_inventory(cache):
    root = snapshot(cache, "tree-root.json")
    if root["sha"] != ROOT_TREE:
        raise ValueError("Cached root tree differs from selected revision")
    snapshots = []
    files = {}
    modules = []
    compiler_tree = snapshot(cache, "tree-compiler.json")
    expected_root = {entry["path"]: entry["sha"] for entry in root["tree"] if entry["type"] == "tree"}
    if compiler_tree["sha"] != expected_root["compiler"]:
        raise ValueError("Compiler subtree is not rooted at the selected revision")
    compiler_children = {entry["path"]: entry["sha"] for entry in compiler_tree["tree"] if entry["type"] == "tree"}

    def verify_rooted(prefix, value):
        expected = compiler_children[prefix.removeprefix("compiler/")] if prefix.startswith("compiler/") else expected_root[prefix]
        if value["sha"] != expected:
            raise ValueError("Selected subtree is not rooted at the pinned commit: " + prefix)

    def take(tree, prefix, module, path, role=None):
        if tree["type"] != "blob" or tree["mode"] not in ["100644", "100755"]:
            raise ValueError("Selected compiler input is not a regular Git blob")
        relative = prefix + "/" + path
        if relative in files:
            return
        size = tree.get("size")
        if not isinstance(size, int) or not 0 <= size <= MAX_FILE:
            raise ValueError("Selected compiler input exceeds source bound")
        suffix = pathlib.PurePosixPath(path).suffix
        language = {".kt": "kotlin", ".java": "java", ".proto": "proto"}.get(suffix, "build")
        role = role or ("checked-in-generated" if "/gen/" in "/" + path or "/generated/" in "/" + path else "source")
        if language == "proto":
            role = "generator-input"
        compile = language == "kotlin" and role not in ["generator-input", "reference-only"]
        if module == "compiler/fir/entrypoint" and pathlib.PurePosixPath(path).name in EXCLUDED_ENTRYPOINT:
            compile, role = False, "profile-excluded"
        files[relative] = {"path": relative, "gitBlob": tree["sha"], "bytes": size,
                           "language": language, "compile": compile, "role": role, "module": module}

    for filename, (prefix, selected) in GROUPS.items():
        value = snapshot(cache, filename)
        verify_rooted(prefix, value)
        snapshots.append({"path": prefix, "gitTree": value["sha"], "entries": len(value["tree"]), "recomputed": True})
        for directory in selected:
            module = prefix + "/" + directory
            roots = [directory + "/src/", directory + "/gen/"]
            modules.append({"directory": module, "sourceRoots": [module + "/src", module + "/gen"]})
            for entry in value["tree"]:
                path = entry["path"]
                if entry["type"] == "blob" and (path == directory + "/build.gradle.kts" or
                        any(path.startswith(p) for p in roots) and path.endswith((".kt", ".java", ".proto"))):
                    take(entry, prefix, module, path)
            generator = GENERATORS.get(module)
            if generator:
                for entry in value["tree"]:
                    if entry["type"] == "blob" and entry["path"].startswith(generator + "/") and entry["path"].endswith((".kt", ".java", "build.gradle.kts")):
                        take(entry, prefix, generator, entry["path"], "generator-input")
    for prefix in DIRECT:
        value = snapshot(cache, "discovery-tree-" + prefix.replace("/", "_") + ".json")
        verify_rooted(prefix, value)
        snapshots.append({"path": prefix, "gitTree": value["sha"], "entries": len(value["tree"]), "recomputed": True})
        modules.append({"directory": prefix, "sourceRoots": [prefix + "/src", prefix + "/gen"]})
        for entry in value["tree"]:
            path = entry["path"]
            if entry["type"] == "blob" and (path == "build.gradle.kts" or
                    path.startswith(("src/", "gen/")) and path.endswith((".kt", ".java", ".proto"))):
                take(entry, prefix, prefix, path)
    parser = snapshot(cache, "tree-compiler_parser.json")
    verify_rooted("compiler/multiplatform-parsing", parser)
    snapshots.append({"path": "compiler/multiplatform-parsing", "gitTree": parser["sha"], "entries": len(parser["tree"]), "recomputed": True})
    modules.append({"directory": "compiler/multiplatform-parsing", "sourceRoots": ["compiler/multiplatform-parsing/common/src"]})
    for entry in parser["tree"]:
        if entry["type"] == "blob" and (entry["path"].startswith("common/src/") or entry["path"] == "build.gradle.kts"):
            take(entry, "compiler/multiplatform-parsing", "compiler/multiplatform-parsing", entry["path"])
    cli = snapshot(cache, "tree-compiler_cli.json")
    verify_rooted("compiler/cli", cli)
    snapshots.append({"path": "compiler/cli", "gitTree": cli["sha"], "entries": len(cli["tree"]), "recomputed": True})
    for entry in cli["tree"]:
        if entry["type"] == "blob" and pathlib.PurePosixPath(entry["path"]).name in REFERENCE_NAMES:
            take(entry, "compiler/cli", "compiler/cli", entry["path"], "reference-only")
    fir = snapshot(cache, "tree-compiler_fir.json")
    for entry in fir["tree"]:
        if entry["type"] == "blob" and entry["path"].endswith("/FirCliSession.kt"):
            take(entry, "compiler/fir", "compiler/fir/fir-jvm", entry["path"])
    values = sorted(files.values(), key=lambda p: p["path"])
    if len(values) > 10000 or sum(p["bytes"] for p in values) > MAX_CLOSURE:
        raise ValueError("Selected compiler closure exceeds bounded preparation budget")
    return values, modules, snapshots


def validate_pins(pins, with_sha):
    if not isinstance(pins, list) or not 0 < len(pins) <= 10000:
        raise ValueError("Compiler input file count exceeds bound")
    paths = set()
    total = 0
    for pin in pins:
        path = pin.get("path")
        if (not isinstance(path, str) or not path or "\\" in path or "\0" in path or
                pathlib.PurePosixPath(path).is_absolute() or any(part in ("", ".", "..") for part in path.split("/"))):
            raise ValueError("Compiler source path is not a canonical relative path")
        if path in paths:
            raise ValueError("Compiler source path is duplicated: " + path)
        paths.add(path)
        size = pin.get("bytes")
        if type(size) is not int or not 0 <= size <= MAX_FILE:
            raise ValueError("Compiler source byte count exceeds bound")
        total += size
        if not isinstance(pin.get("gitBlob"), str) or not re.fullmatch(r"[0-9a-f]{40}", pin["gitBlob"]):
            raise ValueError("Compiler source Git blob identity is malformed")
        if with_sha and (not isinstance(pin.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", pin["sha256"])):
            raise ValueError("Compiler source SHA-256 identity is malformed")
        if pin.get("language") not in ("kotlin", "java", "proto", "build") or type(pin.get("compile")) is not bool:
            raise ValueError("Compiler source language/selection is malformed")
        if pin.get("role") not in ("source", "checked-in-generated", "generator-input", "reference-only", "profile-excluded"):
            raise ValueError("Compiler source role is malformed")
        if pin["compile"] and (pin["language"] != "kotlin" or pin["role"] in ("generator-input", "reference-only", "profile-excluded")):
            raise ValueError("Compiler source compile selection contradicts source role")
    if total > MAX_CLOSURE:
        raise ValueError("Compiler source closure byte count exceeds bound")


def prepare_file(pin, output, source_cache, with_sha):
    target = regular_path(output / "sources" / pin["path"])
    cached = regular_path(source_cache / pin["path"]) if source_cache else None
    if target.is_file():
        data = read_regular(target, pin["bytes"], exact_size=pin["bytes"])
    elif cached and cached.is_file():
        data = read_regular(cached, pin["bytes"], exact_size=pin["bytes"])
    else:
        url = "https://raw.githubusercontent.com/JetBrains/kotlin/" + COMMIT + "/" + urllib.parse.quote(pin["path"], safe="/")
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read(pin["bytes"] + 1)
    if len(data) != pin["bytes"] or hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest() != pin["gitBlob"]:
        raise ValueError("Selected compiler source Git blob mismatch: " + pin["path"])
    digest = sha256(data)
    if with_sha and digest != pin["sha256"]:
        raise ValueError("Selected compiler source SHA-256 mismatch: " + pin["path"])
    if not target.exists():
        write_new_bytes(target, data)
    return {**pin, "sha256": digest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["inventory", "references", "prepare"])
    parser.add_argument("--tree-cache", type=pathlib.Path)
    parser.add_argument("--source-cache", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, default=HERE.parents[2] / "out/kotlin-compiler-port")
    parser.add_argument("--lock", type=pathlib.Path)
    args = parser.parse_args()
    args.lock = args.lock or HERE / ("closure.references.lock.json" if args.command == "references" else "closure.lock.json")
    output = regular_path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    source_cache = regular_path(args.source_cache) if args.source_cache else None
    if args.command in ("inventory", "references"):
        if not args.tree_cache:
            parser.error("inventory requires --tree-cache with complete pinned Git tree snapshots")
        pins, modules, snapshots = load_inventory(regular_path(args.tree_cache))
        if args.command == "references":
            pins = [pin for pin in pins if pin["role"] in ("reference-only", "generator-input")]
        print(json.dumps({"selectedFiles": len(pins), "kotlinSources": sum(p["compile"] for p in pins),
                          "bytes": sum(p["bytes"] for p in pins)}), flush=True)
    else:
        lock = json.loads(read_regular(args.lock, 16 * 1024 * 1024))
        if lock["source"] != SOURCE or lock["schemaVersion"] != 1:
            raise ValueError("Compiler source lock identity differs")
        pins, modules, snapshots = lock["files"], lock["modules"], lock["treeSnapshots"]
    validate_pins(pins, args.command == "prepare")
    files = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(prepare_file, pin, output, source_cache, args.command == "prepare") for pin in pins]
        for index, future in enumerate(futures):
            files.append(future.result())
            if (index + 1) % 200 == 0:
                print("verified compiler source files:", index + 1, flush=True)
    if args.command in ("inventory", "references"):
        lock = {"schemaVersion": 1, "source": SOURCE, "bootstrapVersion": "2.5.0-dev-10106",
                "compilerHostTarget": "wasmJs", "userProgramTarget": "wasmWasi", "modules": modules,
                "treeSnapshots": snapshots, "files": files,
                "excludedPolicy": ["JVM/native backends, Java frontend, IDE plugins, daemon and CLI pipeline drivers are excluded.",
                                   "Selected official CLI pipeline files are reference-only; their environment construction is not compiled.",
                                   "Java declarations are pinned but cannot be compiled for wasmJs; required declarations need real portable adapters/codecs.",
                                   "Checked-in generated Kotlin is preserved. Generators run on the build host, not in the browser."],
                "unresolved": ["Selected module/source-root inventory is a build candidate; complete symbol closure is determined by actual compiler errors.",
                               "JVM imports and source-element carriers need host patches before wasmJs compilation can pass.",
                               "Official metadata/IR generated Java requires the schema-preserving portable codec workstream."],
                "languageReadiness": False}
        write_new_json(args.lock, lock)
    receipt = {"schemaVersion": 1, "kind": "official-compiler-port-source-preparation", "source": SOURCE,
               "lockSha256": sha256(read_regular(args.lock, 16 * 1024 * 1024)), "sourceRoot": str(output / "sources"),
               "files": len(files), "kotlinCompileSources": sum(p["compile"] for p in files),
               "bytes": sum(p["bytes"] for p in files), "sourceBytesVerified": True,
               "compilerBuild": "not-run", "browserCompiler": "not-built", "languageReadiness": False}
    write_new_json(output / ("reference-inputs.json" if args.command == "references" else "inputs.json"), receipt)
    print(json.dumps(receipt), flush=True)


if __name__ == "__main__":
    main()
