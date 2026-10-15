#!/usr/bin/env python3
"""Derive the container process-profile sysroot from the pinned selected-target sysroot.

User programs linked against the pinned sysroot start with WASI libc's default cwd `/`.
This helper links the same `initial-cwd.c` constructor that Clang and LLD carry into the
sysroot's `crt1.o` with `wasm-ld -r`, so every executable linked against the result calls
`wasm_idle_process_v1.initial_cwd` and the real libc `chdir()` before `main`. Every other
archive entry is copied byte for byte. The pinned tar and tools are read-only inputs; this
helper downloads nothing and publishes nothing.
"""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time


HERE = Path(__file__).resolve().parent
CRT = "lib/wasm32-wasi/crt1.o"
PROFILE_ID = "wasm-llvm/clang-browser/container-process-sysroot-v1"


def identity_bytes(data):
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def identity(path):
    return identity_bytes(Path(path).read_bytes())


def leb(data, offset):
    result = shift = 0
    while True:
        byte = data[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return result, offset


def name(data, offset):
    length, offset = leb(data, offset)
    return data[offset:offset + length].decode("utf-8"), offset + length


def object_profile(data):
    """Function imports and init-function priorities of a relocatable Wasm object."""
    if data[:8] != b"\0asm\x01\0\0\0":
        raise ValueError("not a version 1 Wasm module")
    imports, priorities, offset = [], [], 8
    while offset < len(data):
        section, offset = data[offset], offset + 1
        size, offset = leb(data, offset)
        end = offset + size
        if section == 2:
            count, cursor = leb(data, offset)
            for _ in range(count):
                module, cursor = name(data, cursor)
                field, cursor = name(data, cursor)
                kind, cursor = data[cursor], cursor + 1
                if kind == 0:
                    _, cursor = leb(data, cursor)
                    imports.append([module, field])
                elif kind == 1:
                    cursor += 1
                    flags, cursor = leb(data, cursor)
                    _, cursor = leb(data, cursor)
                    if flags & 1:
                        _, cursor = leb(data, cursor)
                elif kind == 2:
                    flags, cursor = leb(data, cursor)
                    _, cursor = leb(data, cursor)
                    if flags & 1:
                        _, cursor = leb(data, cursor)
                elif kind == 3:
                    cursor += 2
                elif kind == 4:
                    cursor += 1
                    _, cursor = leb(data, cursor)
                else:
                    raise ValueError(f"unsupported import kind {kind}")
        elif section == 0:
            custom, cursor = name(data, offset)
            if custom == "linking":
                _, cursor = leb(data, cursor)
                while cursor < end:
                    kind, cursor = data[cursor], cursor + 1
                    length, cursor = leb(data, cursor)
                    if kind == 6:
                        count, inner = leb(data, cursor)
                        for _ in range(count):
                            priority, inner = leb(data, inner)
                            _, inner = leb(data, inner)
                            priorities.append(priority)
                    cursor += length
        offset = end
    return {"functionImports": imports, "initPriorities": sorted(priorities)}


def safe_members(archive):
    members = archive.getmembers()
    names = set()
    for member in members:
        path = member.name.rstrip("/")
        parts = path.split("/")
        if not path or path.startswith("/") or any(part in ("", ".", "..") for part in parts):
            raise ValueError(f"unsafe sysroot entry: {member.name}")
        if not (member.isfile() or member.isdir()):
            raise ValueError(f"only files and directories are allowed: {member.name}")
        if path in names:
            raise ValueError(f"duplicate sysroot entry: {member.name}")
        names.add(path)
    return members


def run(argv, commands, cwd=None):
    started = time.monotonic()
    result = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True)
    commands.append({"argv": [str(word) for word in argv], "exitCode": result.returncode,
                     "durationSeconds": round(time.monotonic() - started, 3),
                     "stderr": result.stderr.decode("utf-8", "replace")[-4000:]})
    if result.returncode:
        raise RuntimeError(f"command failed: {argv[0]}")
    return result


def rewrite(source, replacement):
    """The same members, order and headers; only crt1.o's bytes and size differ."""
    output = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(source), mode="r:") as original, \
            tarfile.open(fileobj=output, mode="w:", format=original.format) as result:
        for member in safe_members(original):
            if member.isfile():
                data = original.extractfile(member).read()
                if member.name == CRT:
                    data = replacement
                copy = tarfile.TarInfo(member.name)
                for field in ("mode", "uid", "gid", "uname", "gname", "mtime", "type"):
                    setattr(copy, field, getattr(member, field))
                copy.size = len(data)
                result.addfile(copy, io.BytesIO(data))
            else:
                result.addfile(member)
    return output.getvalue()


def compare(source, derived):
    """Every entry except crt1.o is unchanged; returns the entry counts."""
    with tarfile.open(fileobj=io.BytesIO(source), mode="r:") as left, \
            tarfile.open(fileobj=io.BytesIO(derived), mode="r:") as right:
        a, b = safe_members(left), safe_members(right)
        if [m.name for m in a] != [m.name for m in b]:
            raise ValueError("entry names or order changed")
        changed = []
        for x, y in zip(a, b):
            if (x.mode, x.uid, x.gid, x.mtime, x.type) != (y.mode, y.uid, y.gid, y.mtime, y.type):
                raise ValueError(f"entry header changed: {x.name}")
            if x.isfile() and left.extractfile(x).read() != right.extractfile(y).read():
                changed.append(x.name)
        if changed != [CRT]:
            raise ValueError(f"unexpected changed entries: {changed}")
        return {"directory": sum(m.isdir() for m in a), "file": sum(m.isfile() for m in a)}


def build(args):
    output = args.output.resolve()
    if output.exists():
        raise ValueError("output must be fresh")
    if not output.parent.is_dir():
        raise ValueError("output parent must exist")
    sysroot = args.sysroot.resolve()
    source = sysroot.read_bytes()
    if identity_bytes(source)["sha256"] != args.sysroot_sha256:
        raise ValueError("pinned sysroot digest mismatch")
    # wasm-ld is the SDK's symlink to its lld binary; the digest pins the resolved file.
    tools = {"clang": args.wasi_sdk / "bin/clang-22", "wasm-ld": args.wasi_sdk / "bin/wasm-ld"}
    for tool, expected in (("clang", args.clang_sha256), ("wasm-ld", args.wasm_ld_sha256)):
        if identity(tools[tool])["sha256"] != expected:
            raise ValueError(f"pinned {tool} digest mismatch")
    profile = json.loads((HERE / "profile.json").read_text())
    initializer = HERE / profile["initialCwd"]["path"]
    if identity(initializer)["sha256"] != profile["initialCwd"]["sha256"]:
        raise ValueError("initial-cwd.c does not match profile.json")
    os.umask(0o077)
    output.mkdir()
    work = output / "work"
    (work / "sysroot").mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(source), mode="r:") as archive:
        members = safe_members(archive)
        if sum(m.name == CRT for m in members) != 1:
            raise ValueError("the sysroot must contain exactly one crt1.o")
        for member in members:
            target = work / "sysroot" / member.name.rstrip("/")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(member).read())
    original = (work / "sysroot" / CRT).read_bytes()
    before = object_profile(original)
    if ["wasm_idle_process_v1", "initial_cwd"] in before["functionImports"]:
        raise ValueError("the pinned crt1.o already imports initial_cwd")
    commands = []
    root = work / "sysroot"
    # The pinned sysroot's own headers and resource directory; no host include paths.
    run([tools["clang"], "--no-default-config", "--target=wasm32-wasi", f"--sysroot={root}", f"-resource-dir={root}/lib/clang/22",
         "-O2", "-c", initializer, "-o", work / "initial-cwd.o"], commands)
    shutil.copyfile(root / CRT, work / "crt1.original.o")
    run([tools["wasm-ld"], "-r", work / "crt1.original.o", work / "initial-cwd.o",
         "-o", work / "crt1.o"], commands)
    derived_crt = (work / "crt1.o").read_bytes()
    after = object_profile(derived_crt)
    if ["wasm_idle_process_v1", "initial_cwd"] not in after["functionImports"]:
        raise ValueError("derived crt1.o does not import initial_cwd")
    if profile["initialCwd"]["constructorPriority"] not in after["initPriorities"]:
        raise ValueError("derived crt1.o lost the initializer priority")
    derived = rewrite(source, derived_crt)
    counts = compare(source, derived)
    (output / "sysroot.tar").write_bytes(derived)
    # Functional check: a program linked against the derived sysroot alone, without any
    # extra object or flag, honors the host cwd through real getcwd and a relative fopen.
    (root / CRT).write_bytes(derived_crt)
    fixture = work / "cwd-fixture.wasm"
    run([tools["clang"], "--no-default-config", "--target=wasm32-wasi", f"--sysroot={root}", f"-resource-dir={root}/lib/clang/22",
         f"-fuse-ld={tools['wasm-ld']}", "-O2", HERE / "cwd-fixture.c", "-o", fixture], commands)
    linked = object_profile(fixture.read_bytes())
    run([args.node, HERE / "cwd-fixture.mjs", fixture, work / "fixture-root", work / "cwd-fixture.json"], commands)
    fixture_result = json.loads((work / "cwd-fixture.json").read_text())
    if fixture_result.get("passed") is not True:
        raise ValueError("cwd fixture did not pass")
    receipt = {
        "schemaVersion": 1,
        "profileId": PROFILE_ID,
        "complete": True,
        "qualification": "producer-only process-profile sysroot; browser and container qualification are separate",
        "producerCommit": subprocess.run(["git", "rev-parse", "HEAD"], cwd=HERE, capture_output=True, text=True).stdout.strip(),
        "producerTreeClean": not subprocess.run(["git", "status", "--porcelain", "--", "."], cwd=HERE,
                                                capture_output=True, text=True).stdout.strip(),
        "contract": {key: profile["initialCwd"][key] for key in ("module", "name", "capacity", "constructorPriority", "failureExit")},
        "inputs": {
            "sysroot": {"path": str(sysroot), **identity_bytes(source)},
            "initialCwd": {"path": str(initializer), **identity(initializer)},
            "cwdFixture": {"path": str(HERE / "cwd-fixture.c"), **identity(HERE / "cwd-fixture.c")},
            "cwdFixtureHost": {"path": str(HERE / "cwd-fixture.mjs"), **identity(HERE / "cwd-fixture.mjs")},
            "clang": {"path": str(tools["clang"]), **identity(tools["clang"])},
            "wasmLd": {"path": str(tools["wasm-ld"]), "resolved": str(tools["wasm-ld"].resolve()), **identity(tools["wasm-ld"])},
            "node": {"path": str(args.node), **identity(args.node)},
            # The SDK driver's shared libraries, recorded rather than separately pinned.
            "clangLibraries": {name: identity(args.wasi_sdk / "lib" / name)
                               for name in ("libLLVM.so.22.1-wasi-sdk", "libclang-cpp.so.22.1-wasi-sdk")},
        },
        "commands": commands,
        "crt1": {"path": CRT, "original": identity_bytes(original), "derived": identity_bytes(derived_crt),
                 "originalProfile": before, "derivedProfile": after},
        "initialCwdObject": identity(work / "initial-cwd.o"),
        "entryCounts": counts,
        "changedEntries": [CRT],
        "linkedFixture": {**identity(fixture), "functionImports": linked["functionImports"]},
        "cwdFixture": fixture_result,
        "outputs": {"sysroot.tar": identity_bytes(derived)},
    }
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    shutil.rmtree(work / "sysroot")
    shutil.rmtree(work / "fixture-root")
    print(json.dumps({"output": str(output), "sysroot": receipt["outputs"]["sysroot.tar"], "entryCounts": counts}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sysroot", type=Path, required=True)
    parser.add_argument("--sysroot-sha256", required=True)
    parser.add_argument("--wasi-sdk", type=Path, required=True)
    parser.add_argument("--clang-sha256", required=True)
    parser.add_argument("--wasm-ld-sha256", required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    build(parser.parse_args())


if __name__ == "__main__":
    main()
