#!/usr/bin/env python3
"""Fetch only checksum-locked official parser sources and selected variant libraries."""

import argparse
import concurrent.futures
import hashlib
import json
import os
import pathlib
import stat
import tempfile
import urllib.request


HERE = pathlib.Path(__file__).resolve().parent
MAX_PIN_BYTES = 128 * 1024 * 1024


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def regular_path(path):
    """Preserve the requested path and reject existing symlink components."""
    path = pathlib.Path(os.path.abspath(path))
    current = pathlib.Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            raise ValueError(f"Symlink paths are not accepted: {current}")
    return path


def read_regular(path, maximum=8 * 1024 * 1024, exact_size=None):
    path = regular_path(path)
    if isinstance(maximum, bool) or not isinstance(maximum, int) or not 0 <= maximum <= MAX_PIN_BYTES:
        raise ValueError("Invalid bounded file size")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"Expected a regular file: {path}")
        if info.st_size > maximum or exact_size is not None and info.st_size != exact_size:
            raise ValueError(f"File size differs from pin or limit: {path}")
    except Exception:
        os.close(descriptor)
        raise
    with os.fdopen(descriptor, "rb") as stream:
        data = stream.read(maximum + 1)
        if len(data) > maximum or exact_size is not None and len(data) != exact_size:
            raise ValueError(f"File grew or changed beyond its pin: {path}")
        return data


def write_new_bytes(path, data):
    """Publish complete bytes atomically without replacing an existing file."""
    path = regular_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".tmp-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
        os.link(temporary, path)
    finally:
        pathlib.Path(temporary).unlink()


def write_new_json(path, value):
    write_new_bytes(path, (json.dumps(value, indent=2) + "\n").encode("utf-8"))


def checked_bytes(path, record):
    expected = record["bytes"]
    data = read_regular(path, expected, exact_size=expected)
    if len(data) != record["bytes"] or sha256(data) != record["sha256"]:
        raise ValueError(f"Pinned byte identity mismatch: {record.get('path', record.get('name'))}")
    if "gitBlob" in record:
        blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if blob != record["gitBlob"]:
            raise ValueError(f"Pinned Git blob mismatch: {record['path']}")
    return data


def fetch(url, record):
    expected = record["bytes"]
    if isinstance(expected, bool) or not isinstance(expected, int) or not 0 <= expected <= MAX_PIN_BYTES:
        raise ValueError("Invalid download byte pin")
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(expected + 1)
    if len(data) != record["bytes"] or sha256(data) != record["sha256"]:
        raise ValueError(f"Downloaded byte identity mismatch: {record.get('path', record.get('name'))}")
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, default=HERE.parents[2] / "out/kotlin-parser-probe")
    parser.add_argument("--source-cache", type=pathlib.Path)
    args = parser.parse_args()
    recipe = json.loads(read_regular(HERE / "recipe.json"))
    output = regular_path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    source_cache = regular_path(args.source_cache) if args.source_cache else None

    def source(record):
        relative = pathlib.PurePosixPath(record["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Source lock has an unsafe relative path")
        target = regular_path(output / "sources" / relative)
        if target.is_file():
            checked_bytes(target, record)
        else:
            cached = regular_path(source_cache / relative) if source_cache else None
            data = checked_bytes(cached, record) if cached and cached.is_file() else fetch(
                f"https://raw.githubusercontent.com/JetBrains/kotlin/{recipe['source']['commit']}/{relative}",
                record,
            )
            write_new_bytes(target, data)
            checked_bytes(target, record)
        return {**record, "localPath": str(target), "verified": True}

    def artifact(record):
        if pathlib.PurePath(record["name"]).name != record["name"]:
            raise ValueError("Artifact lock has an unsafe name")
        target = regular_path(output / "artifacts" / record["name"])
        if not target.is_file():
            data = fetch(record["url"], record)
            write_new_bytes(target, data)
        checked_bytes(target, record)
        return {**record, "localPath": str(target), "verified": True}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        files = list(pool.map(source, recipe["files"]))
        artifacts = list(pool.map(artifact, recipe["artifacts"]))
    receipt = {
        "schemaVersion": 1,
        "kind": "official-parser-inputs",
        "source": recipe["source"],
        "recipeSha256": sha256(read_regular(HERE / "recipe.json")),
        "files": files,
        "artifacts": artifacts,
        "compilerBuild": "not-run",
    }
    receipt_path = output / "inputs.json"
    try:
        write_new_json(receipt_path, receipt)
    except FileExistsError:
        if json.loads(read_regular(receipt_path)) != receipt:
            raise ValueError("Prepared input receipt already exists with different contents")
    print(json.dumps({"inputs": str(output / "inputs.json"), "files": len(files), "artifacts": len(artifacts)}))


if __name__ == "__main__":
    main()
