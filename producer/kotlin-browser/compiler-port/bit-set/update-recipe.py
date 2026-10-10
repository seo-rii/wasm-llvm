#!/usr/bin/env python3
"""Refresh reproducible recipe pins after reviewing the actual selected source/port."""
import hashlib
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[3]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def pin(path):
    data = (HERE / path).read_bytes()
    return {"path": path, "bytes": len(data), "sha256": digest(data),
            "gitBlob": hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()}


closure_bytes = (HERE.parent / "closure.lock.json").read_bytes()
closure = json.loads(closure_bytes)
consumers = [
    "compiler/ir/backend.common/src/org/jetbrains/kotlin/backend/common/lower/optimizations/LivenessAnalysis.kt",
    "compiler/util/src/org/jetbrains/kotlin/utils/BitSetUtil.kt",
]
recipe = {
    "schemaVersion": 1,
    "kind": "official-wasm-liveness-bit-set-host-port",
    "source": closure["source"],
    "primaryClosureSha256": digest(closure_bytes),
    "consumers": [next(item for item in closure["files"] if item["path"] == path) for path in consumers],
    "jdk": {
        "repository": "https://github.com/openjdk/jdk17u.git",
        "commit": "162dbac82cf31c6948414944af836187aff9e6ca",
        "tag": "jdk-17.0.16+8",
        "sourcePath": "src/java.base/share/classes/java/util/BitSet.java",
        "path": "BitSet.java", "bytes": 48380,
        "sha256": "c5640ef08deab2582948e4cdbd0c1deb7cd83a3e404645ba91835bced5287cfc",
        "gitBlob": "e0dc042bce69ca41af4b47dd256c9f9cc6d741fa",
    },
    "portable": pin("BitSet.kt"),
    "licenses": [pin("LICENSE.OpenJDK"), pin("ASSEMBLY_EXCEPTION.OpenJDK")],
    "selectedApi": ["constructors", "set(Int)", "clear(Int)", "get(Int)", "nextSetBit(Int)", "or(BitSet)", "andNot(BitSet)", "size()", "equals(Any?)", "hashCode()"],
    "hostAdaptations": ["LongArray storage and copy operations", "countTrailingZeroBits intrinsic", "enabled word invariants", "common negative-size exception with original message"],
    "excludedApi": ["range operations", "stream/serialization", "buffer conversions", "clone and sizeIsSticky (selected utility copy preserves capacity without clone)"],
    "languageReadiness": False,
}
(HERE / "sources.lock.json").write_text(json.dumps(recipe, indent=2) + "\n")
print("Refreshed selected BitSet recipe pins.")
