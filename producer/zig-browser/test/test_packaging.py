import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "zig_package", Path(__file__).resolve().parents[1] / "scripts" / "package.py"
)
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.lib = self.root / "lib"
        (self.lib / "std").mkdir(parents=True)
        (self.lib / "std" / "std.zig").write_text("pub const example = 1;\n")
        (self.lib / "compiler_rt.zig").write_text("// runtime fixture\n")

    def fixture(self):
        output = self.root / "output"
        output.mkdir()
        (output / "zig.wasm").write_bytes(b"\0asm\x01\0\0\0")
        (output / "LICENSE").write_text("Fixture license\n")
        producer.pack_library(self.lib, output / "lib.tar.gz")
        library, _ = producer.inspect_library(output / "lib.tar.gz")
        receipt = {
            **producer.load_contract(),
            "assets": {
                "zig.wasm": producer.describe(output / "zig.wasm"),
                "lib.tar.gz": library,
                "LICENSE": producer.describe(output / "LICENSE"),
            },
            "validation": {"passed": True},
        }
        (output / "producer-receipt.json").write_text(json.dumps(receipt))
        return output, receipt

    def test_archive_is_stable_across_source_timestamps(self):
        first, second = self.root / "first.gz", self.root / "second.gz"
        producer.pack_library(self.lib, first)
        os.utime(self.lib / "std" / "std.zig", (12345678, 12345678))
        producer.pack_library(self.lib, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with tarfile.open(first, "r:gz") as archive:
            for member in archive:
                self.assertEqual(member.mtime, 0)
                self.assertEqual(member.uid, 0)
                self.assertEqual(member.gid, 0)

    def test_archive_rejects_unsafe_entries_before_extraction(self):
        for name, kind in [("lib/../../escape", tarfile.REGTYPE), ("lib/link", tarfile.SYMTYPE), ("lib/./alias", tarfile.REGTYPE)]:
            with self.subTest(name=name):
                path = self.root / "unsafe.gz"
                with tarfile.open(path, "w:gz") as archive:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.linkname = "../../escape" if kind == tarfile.SYMTYPE else ""
                    archive.addfile(member, io.BytesIO())
                with self.assertRaisesRegex(ValueError, "Unsafe"):
                    producer.inspect_library(path)

    def test_archive_requires_compiler_runtime(self):
        (self.lib / "compiler_rt.zig").unlink()
        path = self.root / "missing.gz"
        producer.pack_library(self.lib, path)
        with self.assertRaisesRegex(ValueError, "compiler_rt.zig"):
            producer.inspect_library(path)

    def test_payload_mutation_is_rejected(self):
        output, _ = self.fixture()
        producer.verify(output)
        (output / "zig.wasm").write_bytes(b"\0asm\x01\0\0\0tampered")
        with self.assertRaisesRegex(ValueError, "integrity mismatch: zig.wasm"):
            producer.verify(output)

    def test_expanded_library_hash_is_checked(self):
        output, receipt = self.fixture()
        receipt["assets"]["lib.tar.gz"]["uncompressedSha256"] = "0" * 64
        (output / "producer-receipt.json").write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError, "integrity mismatch: lib.tar.gz"):
            producer.verify(output)

    def test_source_identity_and_qualification_are_required(self):
        output, receipt = self.fixture()
        for key, value, expected in [
            ("version", "0.11.0", "mismatched version"),
            ("validation", {"passed": False}, "successful qualification"),
        ]:
            with self.subTest(key=key):
                changed = {**receipt, key: value}
                (output / "producer-receipt.json").write_text(json.dumps(changed))
                with self.assertRaisesRegex(ValueError, expected):
                    producer.verify(output)


if __name__ == "__main__":
    unittest.main()
