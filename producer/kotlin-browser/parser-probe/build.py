#!/usr/bin/env python3
"""Build unchanged official parser sources for JVM and wasmJs with the pinned bootstrap."""

import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time

sys.dont_write_bytecode = True
from prepare import HERE, checked_bytes, read_regular, regular_path, sha256, write_new_bytes, write_new_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, default=HERE.parents[2] / "out/kotlin-parser-probe")
    parser.add_argument("--bootstrap", type=pathlib.Path, required=True)
    parser.add_argument("--java", default="java")
    parser.add_argument("--max-heap-mib", type=int, default=1024)
    args = parser.parse_args()
    if not 256 <= args.max_heap_mib <= 2048:
        parser.error("--max-heap-mib must be between 256 and 2048")
    output = regular_path(args.output)
    receipt_path = regular_path(output / "build-receipt.json")
    if receipt_path.exists():
        raise ValueError("Build receipt already exists; use a fresh --output directory")
    recipe = json.loads(read_regular(HERE / "recipe.json"))
    inputs = json.loads(read_regular(output / "inputs.json"))
    if inputs["recipeSha256"] != sha256(read_regular(HERE / "recipe.json")):
        raise ValueError("Prepared source recipe has changed; run prepare again")
    sources = []
    for record in recipe["files"]:
        path = output / "sources" / record["path"]
        checked_bytes(path, record)
        if record["compile"]:
            sources.append(str(path))
    for record in recipe["artifacts"]:
        checked_bytes(output / "artifacts" / record["name"], record)
    bootstrap_lock = HERE.parent / "build/bootstrap.lock.json"
    bootstrap = json.loads(read_regular(bootstrap_lock))
    if bootstrap["version"] != recipe["bootstrapVersion"]:
        raise ValueError("Bootstrap version does not match the selected source")
    bootstrap_paths = {}
    for record in bootstrap["artifacts"]:
        path = regular_path(args.bootstrap) / record["file"]
        checked_bytes(path, record)
        bootstrap_paths[record["id"]] = path
    compiler_classpath = os.pathsep.join(
        str(bootstrap_paths[record["id"]])
        for record in bootstrap["artifacts"] if record["file"].endswith(".jar")
    )
    java = [args.java, f"-Xmx{args.max_heap_mib}m", "-cp", compiler_classpath]
    commands = []
    receipt = {
        "schemaVersion": 1,
        "kind": "official-parser-build",
        "source": recipe["source"],
        "recipeSha256": sha256(read_regular(HERE / "recipe.json")),
        "bootstrapLockSha256": sha256(read_regular(bootstrap_lock)),
        "bootstrapVersion": bootstrap["version"],
        "bootstrapCompilerSourceCommit": bootstrap["compilerSourceCommit"],
        "observerSources": [{"path": path.name, "sha256": sha256(read_regular(path))} for path in [HERE / "Probe.kt", HERE / "JvmEntry.kt", HERE / "WasmEntry.kt"]],
        "fixturesSha256": sha256(read_regular(HERE / "fixtures.json")),
        "java": subprocess.run([args.java, "-version"], capture_output=True, text=True, check=True).stderr.strip(),
        "commands": commands,
        "status": "building",
        "browserComparison": "not-run",
        "languageSupport": False,
    }

    def run(command, phase, destination=None):
        start = time.monotonic()
        print(f"PHASE {phase}", flush=True)
        stream = regular_path(destination).open("xb") if destination else None
        try:
            result = subprocess.run(command, stdout=stream)
        finally:
            if stream:
                stream.close()
        commands.append({"phase": phase, "argv": command, "exitCode": result.returncode, "elapsedMs": (time.monotonic() - start) * 1000})
        if result.returncode:
            raise subprocess.CalledProcessError(result.returncode, command)

    try:
        jvm_dir = output / "jvm"
        wasm_dir = output / "wasm"
        klib_dir = output / "klib"
        for directory in (jvm_dir, wasm_dir, klib_dir, output / "fixtures"):
            regular_path(directory).mkdir()
        jvm_dependencies = [bootstrap_paths["stdlib-jvm"]] + [
            output / "artifacts" / record["name"] for record in recipe["artifacts"] if record["name"].endswith(".jar")
        ]
        wasm_dependencies = [bootstrap_paths["stdlib-js"]] + [
            output / "artifacts" / record["name"] for record in recipe["artifacts"] if record["name"].endswith(".klib")
        ]
        versions = ["-language-version", recipe["languageVersion"], "-api-version", recipe["apiVersion"]]
        common = ["-Xmulti-platform", "-Xcommon-sources=" + ",".join([*sources, str(HERE / "Probe.kt")])]
        run(java + [
            "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-jvm-target", "17",
            *versions, *common, "-classpath", os.pathsep.join(map(str, jvm_dependencies)), "-d", str(jvm_dir / "parser-probe.jar"),
            *sources, str(HERE / "Probe.kt"), str(HERE / "JvmEntry.kt"),
        ], "jvm-build")
        wasm_compiler = java + ["org.jetbrains.kotlin.cli.js.KotlinWasmCompiler", "-Xwasm-target=wasm-js"]
        libraries = ["-libraries", os.pathsep.join(map(str, wasm_dependencies))]
        run(wasm_compiler + [
            *versions, *common, *libraries, "-Xir-produce-klib-file", "-ir-output-dir", str(klib_dir),
            "-ir-output-name", "parser-probe", "-main", "noCall", *sources,
            str(HERE / "Probe.kt"), str(HERE / "WasmEntry.kt"),
        ], "wasm-klib-build")
        run(wasm_compiler + [
            *libraries, "-Xir-produce-js", f"-Xinclude={klib_dir / 'parser-probe.klib'}",
            "-ir-output-dir", str(wasm_dir), "-ir-output-name", "parser-probe", "-main", "noCall",
            "-Xwasm-enable-array-range-checks", "-Xwasm-enable-asserts",
        ], "wasm-binary-build")
        cases = json.loads(read_regular(HERE / "fixtures.json"))
        for case in cases:
            if "generate" in case:
                specification = case["generate"]
                if specification["kind"] != "top-level-val" or not 1 <= specification["count"] <= 10000:
                    raise ValueError("Unsupported bounded fixture generator")
                case["source"] = "".join(f"val item_{index} = {index}\n" for index in range(specification["count"]))
            path = output / "fixtures" / f"{case['id']}.kt"
            write_new_bytes(path, case["source"].encode("utf-8"))
            case["sourceSha256"] = sha256(read_regular(path))
            case["sourceBytes"] = path.stat().st_size
            case["sourceUtf16"] = len(case["source"].encode("utf-16-le")) // 2
            case["localPath"] = str(path)
        write_new_bytes(output / "cases.json", (json.dumps(cases, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        run([
            args.java, "-ea", f"-Xmx{args.max_heap_mib}m", "-cp",
            os.pathsep.join(map(str, [jvm_dir / "parser-probe.jar", *jvm_dependencies])),
            "org.jetbrains.kotlin.kmp.probe.JvmEntryKt", *[case["localPath"] for case in cases],
        ], "jvm-observe", output / "jvm-results.json")
        snapshots = json.loads(read_regular(output / "jvm-results.json", 32 * 1024 * 1024))
        if len(snapshots) != len(cases):
            raise ValueError("JVM observation count differs from the corpus")
        expectations = []
        for case, snapshot in zip(cases, snapshots):
            if snapshot["utf16Length"] != case["sourceUtf16"]:
                raise ValueError(f"UTF-16 source length differs: {case['id']}")
            errors = sum(marker[0] == "error" for marker in snapshot["markers"])
            expectations.append({
                "id": case["id"], "syntaxErrors": errors,
                "expectationMatched": bool(errors) == case["expectSyntaxError"],
            })
            for _, start, end in snapshot["tokens"]:
                if not 0 <= start <= end <= snapshot["utf16Length"]:
                    raise ValueError(f"Lexer offset outside source: {case['id']}")
        receipt["status"] = "passed"
        receipt["jvmCases"] = len(cases)
        receipt["jvmExpectations"] = expectations
        receipt["jvmExpectationStatus"] = "passed" if all(item["expectationMatched"] for item in expectations) else "failed"
        receipt["outputs"] = [{
            "path": str(path.relative_to(output)), "bytes": path.stat().st_size, "sha256": sha256(read_regular(path))
        } for directory in [jvm_dir, klib_dir, wasm_dir] for path in sorted(directory.rglob("*")) if path.is_file()]
        receipt["baselineOutputs"] = [{
            "path": name, "bytes": (output / name).stat().st_size, "sha256": sha256(read_regular(output / name, 32 * 1024 * 1024))
        } for name in ["cases.json", "jvm-results.json"]]
    except Exception as error:
        receipt["status"] = "failed"
        receipt["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        write_new_json(receipt_path, receipt)
    print(json.dumps({"receipt": str(output / "build-receipt.json"), "status": receipt["status"]}))


if __name__ == "__main__":
    main()
