#!/usr/bin/env python3
"""Verify existing G1 inputs and outputs with the final integrity guards; do not rebuild."""

import argparse
import json
import pathlib
import subprocess
import sys

sys.dont_write_bytecode = True
from prepare import HERE, checked_bytes, read_regular, regular_path, sha256, write_new_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, default=HERE.parents[2] / "out/kotlin-parser-probe")
    parser.add_argument("--bootstrap", type=pathlib.Path, required=True)
    parser.add_argument("--g1-evidence", type=pathlib.Path, default=HERE / "evidence/g1-parser.json")
    parser.add_argument("--evidence", type=pathlib.Path)
    args = parser.parse_args()
    output = regular_path(args.output)
    bootstrap_directory = regular_path(args.bootstrap)
    recipe_bytes = read_regular(HERE / "recipe.json")
    recipe = json.loads(recipe_bytes)
    build_bytes = read_regular(output / "build-receipt.json")
    build = json.loads(build_bytes)
    g1_bytes = read_regular(args.g1_evidence)
    g1 = json.loads(g1_bytes)
    bootstrap_bytes = read_regular(HERE.parent / "build/bootstrap.lock.json")
    bootstrap = json.loads(bootstrap_bytes)
    if build["status"] != "passed" or g1["status"] != "passed":
        raise ValueError("Existing G1 build and browser run must have passed")
    if g1["buildReceiptSha256"] != sha256(build_bytes) or g1["buildCommands"] != build["commands"]:
        raise ValueError("G1 evidence does not bind the completed build")
    for field in ["observerSources", "fixturesSha256", "outputs", "baselineOutputs"]:
        if g1[field] != build[field]:
            raise ValueError(f"G1 evidence differs from completed build field: {field}")
    if recipe["source"] != build["source"] or recipe["source"] != g1["source"]:
        raise ValueError("Selected parser source identity changed")
    if build["recipeSha256"] != sha256(recipe_bytes) or g1["recipeSha256"] != sha256(recipe_bytes):
        raise ValueError("Parser recipe changed after G1")
    if build["bootstrapLockSha256"] != sha256(bootstrap_bytes) or g1["bootstrapLockSha256"] != sha256(bootstrap_bytes):
        raise ValueError("Bootstrap artifact lock changed after G1")
    if bootstrap["version"] != recipe["bootstrapVersion"] or build["bootstrapVersion"] != bootstrap["version"] or \
            bootstrap["selectedSourceCommit"] != recipe["source"]["commit"]:
        raise ValueError("Selected bootstrap version or source relation changed")
    if bootstrap["compilerSourceCommit"] is not None or build["bootstrapCompilerSourceCommit"] is not None:
        raise ValueError("Precompiled bootstrap source identity must remain unknown")
    for record in recipe["files"]:
        checked_bytes(output / "sources" / record["path"], record)
    for record in recipe["artifacts"]:
        checked_bytes(output / "artifacts" / record["name"], record)
    for record in bootstrap["artifacts"]:
        checked_bytes(bootstrap_directory / record["file"], record)
    for record in build["observerSources"]:
        if sha256(read_regular(HERE / record["path"])) != record["sha256"]:
            raise ValueError("Compiled parser observer changed after G1")
    if build["fixturesSha256"] != sha256(read_regular(HERE / "fixtures.json")):
        raise ValueError("Parser fixture specification changed after G1")
    if g1["browserProbeSha256"] != sha256(read_regular(HERE / "browser-probe.mjs")):
        raise ValueError("Executed browser harness changed after G1")
    for record in build["outputs"] + build["baselineOutputs"]:
        checked_bytes(output / record["path"], record)
    test_command = [sys.executable, "-B", str(HERE / "integrity_test.py")]
    result = subprocess.run(test_command, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError("Integrity guard tests failed:\n" + result.stderr)
    receipt = {
        "schemaVersion": 1,
        "kind": "post-build-parser-integrity-preflight",
        "status": "passed",
        "source": recipe["source"],
        "g1EvidenceSha256": sha256(g1_bytes),
        "buildReceiptSha256": sha256(build_bytes),
        "recipeSha256": sha256(recipe_bytes),
        "bootstrapLockSha256": sha256(bootstrap_bytes),
        "verified": {
            "sourceFiles": len(recipe["files"]),
            "parserArtifacts": len(recipe["artifacts"]),
            "bootstrapArtifacts": len(bootstrap["artifacts"]),
            "outputsAndBaselines": len(build["outputs"] + build["baselineOutputs"]),
            "observerSourcesUnchanged": True,
            "fixturesUnchanged": True,
            "browserHarnessUnchanged": True
        },
        "currentToolSources": [{"path": name, "sha256": sha256(read_regular(HERE / name))}
                               for name in ["prepare.py", "build.py", "verify.py", "integrity_test.py"]],
        "integrityTests": {"command": test_command, "exitCode": result.returncode,
                           "stdout": result.stdout, "stderr": result.stderr},
        "command": [sys.executable, *sys.argv],
        "limitations": [
            "This post-build check executed final cache/evidence integrity guards, not the changed build driver.",
            "Compiler inputs, observer sources, fixtures, browser harness and completed output bytes are unchanged.",
            "No compiler or browser rerun was performed for the guard changes; original G1 evidence remains immutable.",
            "FIR, backend and public Kotlin readiness are not established by this check."
        ],
        "languageReadiness": False
    }
    destination = args.evidence or output / "g1-parser-preflight.json"
    write_new_json(destination, receipt)
    print(json.dumps({"evidence": str(destination), "status": "passed", "verified": receipt["verified"]}))


if __name__ == "__main__":
    main()
