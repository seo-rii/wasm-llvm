#!/usr/bin/env python3
"""Focused cache and evidence integrity checks; no compiler invocation or downloads."""

import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
from prepare import MAX_PIN_BYTES, checked_bytes, read_regular, regular_path, sha256, write_new_bytes, write_new_json


class IntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kotlin-parser-integrity-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.data = b"verified parser dependency"
        self.pin = {"name": "fixture.klib", "bytes": len(self.data), "sha256": sha256(self.data)}

    def test_verified_bytes_and_same_size_tamper(self):
        file = self.root / "fixture.klib"
        file.write_bytes(self.data)
        self.assertEqual(checked_bytes(file, self.pin), self.data)
        file.write_bytes(b"x" * len(self.data))
        with self.assertRaisesRegex(ValueError, "Pinned byte identity mismatch"):
            checked_bytes(file, self.pin)

    def test_sparse_oversized_cache_rejected_before_read(self):
        file = self.root / "oversized.klib"
        with file.open("wb") as stream:
            stream.truncate(MAX_PIN_BYTES + 1)
        with self.assertRaisesRegex(ValueError, "File size differs from pin or limit"):
            checked_bytes(file, self.pin)

    def test_invalid_pin_budget_rejected(self):
        file = self.root / "fixture.klib"
        file.write_bytes(self.data)
        for size in [True, -1, MAX_PIN_BYTES + 1]:
            with self.subTest(size=size), self.assertRaisesRegex(ValueError, "Invalid bounded file size"):
                checked_bytes(file, {**self.pin, "bytes": size})

    def test_leaf_and_parent_symlinks_rejected(self):
        directory = self.root / "real"
        directory.mkdir()
        target = directory / "fixture.klib"
        target.write_bytes(self.data)
        leaf = self.root / "leaf.klib"
        leaf.symlink_to(target)
        parent = self.root / "linked-directory"
        parent.symlink_to(directory, target_is_directory=True)
        for file in [leaf, parent / "fixture.klib"]:
            with self.subTest(file=file), self.assertRaisesRegex(ValueError, "Symlink paths are not accepted"):
                checked_bytes(file, self.pin)
        with self.assertRaisesRegex(ValueError, "Symlink paths are not accepted"):
            regular_path(parent / "new-output")

    def test_non_regular_cache_rejected_without_blocking(self):
        with self.assertRaisesRegex(ValueError, "Expected a regular file"):
            read_regular(self.root)
        if hasattr(os, "mkfifo"):
            fifo = self.root / "fifo.klib"
            os.mkfifo(fifo)
            with self.assertRaisesRegex(ValueError, "Expected a regular file"):
                checked_bytes(fifo, self.pin)

    def test_completed_receipt_cannot_be_replaced(self):
        receipt = self.root / "receipt.json"
        original = {"status": "passed", "sha256": self.pin["sha256"]}
        write_new_json(receipt, original)
        with self.assertRaises(FileExistsError):
            write_new_json(receipt, {"status": "failed"})
        self.assertEqual(json.loads(read_regular(receipt)), original)
        self.assertEqual(list(self.root.glob("*.tmp-*")), [])

    def test_symlink_output_cannot_overwrite_target(self):
        target = self.root / "target.json"
        target.write_bytes(self.data)
        link = self.root / "receipt.json"
        link.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "Symlink paths are not accepted"):
            write_new_bytes(link, b"replacement")
        self.assertEqual(target.read_bytes(), self.data)
        self.assertEqual(list(self.root.glob("*.tmp-*")), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
