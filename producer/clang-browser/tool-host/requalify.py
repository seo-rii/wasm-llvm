#!/usr/bin/env python3
"""Reverify pinned successful raw links after a verifier-only failure.

Never changes the failed candidate, relinks, or qualifies its CLI. The caller
supplies independent receipt and executable hashes; all original link inputs
must still match. This deliberately supports only the unoptimized local profile.
"""
import argparse
import gzip
import json
from pathlib import Path
import re
import shutil

from build import HERE, CommandFailure, identity, run_bounded, validate_output


def digest(value):
    if not re.fullmatch(r"[a-f0-9]{64}", value):
        raise argparse.ArgumentTypeError("expected lowercase SHA-256")
    return value


def validate_history(receipt, candidate):
    if receipt.get("schemaVersion") != 1 or receipt.get("complete") is not False:
        raise ValueError("an incomplete schema-1 source receipt is required")
    if receipt.get("optimization") != "none":
        raise ValueError("only unchanged raw links can be requalified")
    commands = receipt.get("commands", [])
    if not commands:
        raise ValueError("source receipt has no command history")
    failed = commands[-1]
    argv = failed.get("argv", [])
    expected_tail = [str(candidate / "source-pack/verify.mjs"),
                     str(candidate / "lld.wasm"), str(candidate / "lld.module.json"),
                     "--initial-cwd", "--kind=lld"]
    if (len(argv) != 6 or Path(argv[0]).name != "node" or argv[1:] != expected_tail
            or failed.get("exitCode") != 1 or failed.get("termination") != "exited"):
        raise ValueError("source failure must be the final LLD verifier, not a link or timeout")
    if any(command.get("exitCode") != 0 or command.get("termination") != "exited"
           for command in commands[:-1]):
        raise ValueError("all preceding build commands must have succeeded")
    for kind in ["clang", "lld"]:
        output = str(candidate / f"{kind}.raw.wasm")
        links = [command for command in commands[:-1]
                 if Path(command["argv"][0]).name == "clang++"
                 and "-o" in command["argv"]
                 and command["argv"][command["argv"].index("-o") + 1] == output]
        if len(links) != 1:
            raise ValueError(f"exactly one successful {kind} link is required")


def validate_candidate(candidate, expected_receipt, expected_tools):
    candidate = candidate.resolve()
    source_receipt = candidate / "build-receipt.json"
    if identity(source_receipt)["sha256"] != expected_receipt:
        raise ValueError("source receipt digest mismatch")
    receipt = json.loads(source_receipt.read_text())
    validate_history(receipt, candidate)
    for kind, expected in expected_tools.items():
        final = identity(candidate / f"{kind}.wasm")
        if final["sha256"] != expected or identity(candidate / f"{kind}.raw.wasm") != final:
            raise ValueError(f"{kind} executable digest mismatch or raw bytes changed")
    if receipt["profile"] != json.loads((HERE / "profile.json").read_text()):
        raise ValueError("producer ABI profile changed; a new build is required")
    if identity(HERE.parent / "manifest.json") != receipt["producerManifest"]:
        raise ValueError("producer manifest changed")
    # A verifier-only repair cannot replace the source recipe or compiled inputs.
    for name in ["build.py", "profile.json", "llvm-tool-host.patch", "initial-cwd.c"]:
        if identity(candidate / "source-pack" / name) != identity(HERE / name):
            raise ValueError(f"compiled source recipe changed: {name}")
    for path, expected in receipt["inputs"].items():
        if identity(path) != expected:
            raise ValueError(f"original input changed: {path}")
    return receipt


def requalify(args):
    candidate, output = args.candidate.resolve(), args.output.resolve()
    expected_tools = {"clang": args.clang_sha256, "lld": args.lld_sha256}
    original = validate_candidate(candidate, args.source_receipt_sha256, expected_tools)
    protected = [candidate, HERE, *(Path(path).parent for path in original["inputs"])]
    validate_output(output, protected)
    if shutil.disk_usage(output.parent).free < 512 * 1024**2:
        raise ValueError("at least 512 MiB free disk required")
    source_identity = identity(candidate / "build-receipt.json")
    original_source_pack = {str(path.relative_to(candidate / "source-pack")): identity(path)
                            for path in sorted((candidate / "source-pack").rglob("*"))
                            if path.is_file()}
    receipt = {**original, "complete": False, "commands": list(original["commands"][:-1]),
               "previousFailedVerification": original["commands"][-1],
               "requalification": {"sourceReceipt": str(candidate / "build-receipt.json"),
                                    "sourceReceiptIdentity": source_identity,
                                    "expectedExecutableSha256": expected_tools,
                                    "priorSourcePack": original_source_pack,
                                    "verifierIdentity": identity(HERE / "verify.mjs"),
                                    "helperIdentity": identity(Path(__file__)),
                                    "reason": "verifier-only LLD exec_v1 profile correction; no relink",
                                    "cliQualified": False}}
    receipt.pop("failure", None)
    output.mkdir(mode=0o700)
    receipt_file, phase_file = output / "build-receipt.json", output / "phase.json"

    def phase(value):
        phase_file.write_text(json.dumps({"phase": value}) + "\n")
        receipt_file.write_text(json.dumps(receipt, indent=2) + "\n")

    try:
        phase("copy-pinned-links")
        overlay = output / "source-pack"
        shutil.copytree(candidate / "source-pack", overlay)
        shutil.copyfile(candidate / "build-receipt.json", output / "prior-build-receipt.json")
        shutil.copyfile(overlay / "verify.mjs", overlay / "verify.previous.mjs")
        shutil.copyfile(HERE / "verify.mjs", overlay / "verify.mjs")
        shutil.copyfile(Path(__file__), overlay / "requalify.py")
        outputs = []
        for kind in ["clang", "lld"]:
            for suffix in ["raw.wasm", "wasm"]:
                name = f"{kind}.{suffix}"
                shutil.copyfile(candidate / name, output / name)
                if identity(output / name)["sha256"] != expected_tools[kind]:
                    raise ValueError("copied executable digest mismatch")
                outputs.append(name)
            phase(f"verify:{kind}")
            try:
                command = run_bounded([args.node, str(overlay / "verify.mjs"),
                                       str(output / f"{kind}.wasm"), str(output / f"{kind}.module.json"),
                                       "--initial-cwd", f"--kind={kind}"], output, 60,
                                      original["limits"]["addressSpaceBytesPerProcess"], 1)
            except CommandFailure as error:
                receipt["commands"].append(error.result)
                raise
            receipt["commands"].append(command)
            phase(f"gzip:{kind}")
            with (output / f"{kind}.wasm").open("rb") as source, (output / f"{kind}.wasm.gz").open("wb") as target:
                with gzip.GzipFile(filename="", mode="wb", fileobj=target, mtime=0, compresslevel=9) as archive:
                    shutil.copyfileobj(source, archive)
            outputs.extend([f"{kind}.module.json", f"{kind}.wasm.gz"])
        # Recheck originals after the asynchronous verifier calls and compression.
        validate_candidate(candidate, args.source_receipt_sha256, expected_tools)
        if original_source_pack != {str(path.relative_to(candidate / "source-pack")): identity(path)
                                   for path in sorted((candidate / "source-pack").rglob("*")) if path.is_file()}:
            raise ValueError("original source pack changed")
        receipt["readOnlyInputsUnchanged"] = True
        receipt["outputs"] = {name: identity(output / name) for name in outputs}
        receipt["sourcePack"] = {str(path.relative_to(overlay)): identity(path)
                                 for path in sorted(overlay.rglob("*")) if path.is_file()}
        receipt["complete"] = True
        phase("complete")
    except BaseException as error:
        receipt["failure"] = str(error)
        phase("failed")
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-receipt-sha256", required=True, type=digest)
    parser.add_argument("--clang-sha256", required=True, type=digest)
    parser.add_argument("--lld-sha256", required=True, type=digest)
    parser.add_argument("--node", default="node", help="explicit verifier interpreter")
    requalify(parser.parse_args())


if __name__ == "__main__":
    main()
