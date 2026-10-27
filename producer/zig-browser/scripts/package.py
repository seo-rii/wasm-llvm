#!/usr/bin/env python3
"""Package or verify the pinned Zig WASI compiler and its complete library."""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ROOT.parent.parent
PAYLOADS = ("zig.wasm", "lib.tar.gz", "LICENSE")
MAX_LIBRARY_BYTES = 256 * 1024 * 1024
MAX_LIBRARY_FILES = 32768


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def describe(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Expected a regular file: {path}")
    return {"bytes": path.stat().st_size, "sha256": sha256(path)}


def load_contract():
    manifest_path = ROOT / "manifest.json"
    lock_path = ROOT / "sources.lock.json"
    manifest = json.loads(manifest_path.read_text())
    lock = json.loads(lock_path.read_text())
    if sha256(lock_path) != manifest["sourceLockSha256"]:
        raise ValueError("Source lock does not match producer manifest")
    if sha256(ROOT / lock["port"]["patch"]) != lock["port"]["sha256"]:
        raise ValueError("WASI patch does not match pinned port")
    source = lock["archives"][f"zig-{lock['version']}"]
    identity = {
        "schemaVersion": 1,
        "producerId": manifest["producerId"],
        "profileId": manifest["profileId"],
        "version": lock["version"],
        "target": manifest["target"],
        "wasi": manifest["wasi"],
        "source": source,
        "port": {
            "repository": lock["port"]["repository"],
            "revision": lock["port"]["commit"],
            "patchSha256": lock["port"]["sha256"],
        },
        "sourceLockSha256": sha256(lock_path),
        "manifestSha256": sha256(manifest_path),
    }
    return identity


def pack_library(library, destination):
    """Normalize archive paths, modes, ownership and timestamps for stable bytes."""
    with destination.open("wb") as raw:
        with gzip.GzipFile(fileobj=raw, filename="", mode="wb", compresslevel=9, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
                paths = [library, *sorted(library.rglob("*"))]
                for path in paths:
                    if path.is_symlink() or not (path.is_file() or path.is_dir()):
                        raise ValueError(f"Unsupported library entry: {path}")
                    name = "lib" if path == library else "lib/" + path.relative_to(library).as_posix()
                    info = tarfile.TarInfo(name)
                    info.mode = 0o755 if path.is_dir() else 0o644
                    info.type = tarfile.DIRTYPE if path.is_dir() else tarfile.REGTYPE
                    if path.is_file():
                        info.size = path.stat().st_size
                        with path.open("rb") as data:
                            archive.addfile(info, data)
                    else:
                        archive.addfile(info)


def inspect_library(path):
    digest = hashlib.sha256()
    expanded = 0
    with gzip.open(path, "rb") as data:
        for chunk in iter(lambda: data.read(1024 * 1024), b""):
            expanded += len(chunk)
            if expanded > MAX_LIBRARY_BYTES:
                raise ValueError("Library archive exceeds expanded byte limit")
            digest.update(chunk)
    names = {}
    parent_directories = set()
    files = 0
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            name = member.name
            parts = PurePosixPath(name).parts
            if (
                not parts or parts[0] != "lib" or ".." in parts
                or name.startswith("/") or "\\" in name
                or str(PurePosixPath(name)) != name.rstrip("/")
                or not (member.isfile() or member.isdir())
                or name in names
            ):
                raise ValueError(f"Unsafe or duplicate library entry: {name}")
            for parent in PurePosixPath(name).parents:
                if names.get(str(parent)) == "file":
                    raise ValueError(f"Library path collision: {name}")
                parent_directories.add(str(parent))
            if member.isfile() and name in parent_directories:
                raise ValueError(f"Library path collision: {name}")
            names[name] = "file" if member.isfile() else "directory"
            files += member.isfile()
            if len(names) > MAX_LIBRARY_FILES:
                raise ValueError("Library archive exceeds entry limit")
    for required in ("lib/std/std.zig", "lib/compiler_rt.zig"):
        if names.get(required) != "file":
            raise ValueError(f"Library archive is missing {required}")
    return {
        **describe(path),
        "uncompressedBytes": expanded,
        "uncompressedSha256": digest.hexdigest(),
    }, files


def verify(output, smoke=False):
    identity = load_contract()
    receipt = json.loads((output / "producer-receipt.json").read_text())
    for key, value in identity.items():
        if receipt.get(key) != value:
            raise ValueError(f"Producer receipt has mismatched {key}")
    if receipt.get("validation", {}).get("passed") is not True:
        raise ValueError("Producer receipt has no successful qualification")
    if set(receipt.get("assets", {})) != set(PAYLOADS):
        raise ValueError("Producer receipt has unexpected payloads")
    for name in PAYLOADS:
        actual = describe(output / name)
        if name == "lib.tar.gz":
            actual, _ = inspect_library(output / name)
        if actual != receipt["assets"][name]:
            raise ValueError(f"Asset integrity mismatch: {name}")
    with (output / "zig.wasm").open("rb") as binary:
        if binary.read(8) != b"\0asm\x01\0\0\0":
            raise ValueError("Compiler is not a WebAssembly core module")
    if smoke:
        run_smoke(output)
    return receipt


def run_smoke(output):
    # inspect_library has rejected links, special files and unsafe paths first.
    inspect_library(output / "lib.tar.gz")
    with tempfile.TemporaryDirectory(prefix="zig-producer-smoke-") as tmp:
        with tarfile.open(output / "lib.tar.gz", "r:gz") as archive:
            archive.extractall(tmp)
        subprocess.run([
            "node", str(ROOT / "test" / "smoke.mjs"),
            str(output / "zig.wasm"), str(Path(tmp) / "lib"),
        ], check=True)


def package(bundle, output):
    identity = load_contract()
    build = json.loads((bundle / "build-info.json").read_text())
    expected = {
        "version": identity["version"],
        "native_version": identity["version"],
        "target": identity["target"],
        "source_sha256": identity["source"]["sha256"],
        "patch_sha256": identity["port"]["patchSha256"],
        "source_lock_sha256": identity["sourceLockSha256"],
        "wasm_sha256": sha256(bundle / "zig.wasm"),
    }
    if build != expected:
        raise ValueError("Build metadata does not match the pinned producer inputs")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".zig-package-", dir=output.parent) as tmp:
        staged = Path(tmp)
        shutil.copy2(bundle / "zig.wasm", staged / "zig.wasm")
        shutil.copy2(bundle / "LICENSE", staged / "LICENSE")
        pack_library(bundle / "lib", staged / "lib.tar.gz")
        library_receipt, file_count = inspect_library(staged / "lib.tar.gz")
        run_smoke(staged)
        receipt = {
            **identity,
            "assets": {
                "zig.wasm": describe(staged / "zig.wasm"),
                "lib.tar.gz": library_receipt,
                "LICENSE": describe(staged / "LICENSE"),
            },
            "validation": {
                "passed": True,
                "suite": "producer/zig-browser/test/smoke.mjs",
                "suiteSha256": sha256(ROOT / "test" / "smoke.mjs"),
                "libraryFiles": file_count,
                "checks": ["version", "stdio", "filesystem", "diagnostics", "compiler-rt", "object-linking", "stripped-mvp-object"],
            },
        }
        (staged / "producer-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        verify(staged)
        output.mkdir(parents=True, exist_ok=True)
        for name in (*PAYLOADS, "producer-receipt.json"):
            os.replace(staged / name, output / name)
    print(f"Packaged and qualified Zig {identity['version']}: {output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, default=REPO_ROOT / "out" / "zig-browser" / "bundle")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "artifacts" / "zig-browser")
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--smoke", action="store_true", help="Execute programs from an existing package during verification")
    args = parser.parse_args()
    if args.verify:
        verify(args.output.resolve(), smoke=args.smoke)
        print(f"Verified Zig producer artifacts: {args.output}")
    else:
        package(args.bundle.resolve(), args.output.resolve())


if __name__ == "__main__":
    main()
