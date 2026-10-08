"""Focused boundary tests for verified official compiler source preparation."""

import hashlib
import importlib.util
import pathlib
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("compiler_closure", pathlib.Path(__file__).with_name("closure.py"))
closure = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(closure)


class ClosureInputsTest(unittest.TestCase):
    def pin(self, data=b"package probe\n"):
        return {"path": "compiler/probe/src/Probe.kt", "gitBlob": hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest(),
                "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "language": "kotlin",
                "compile": True, "role": "source", "module": "compiler/probe"}

    def test_valid_selection_and_generated_java_nonselection(self):
        pin = self.pin()
        closure.validate_pins([pin], True)
        java = {**pin, "path": "compiler/probe/src/Probe.java", "compile": False, "language": "java"}
        closure.validate_pins([pin, java], True)

    def test_noncanonical_or_duplicate_paths_fail_before_io(self):
        pin = self.pin()
        for path in ("../Probe.kt", "/Probe.kt", "compiler//Probe.kt", "compiler/./Probe.kt", "compiler\\Probe.kt", "compiler/Probe\0.kt"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                closure.validate_pins([{**pin, "path": path}], True)
        with self.assertRaisesRegex(ValueError, "duplicated"):
            closure.validate_pins([pin, pin], True)

    def test_size_hash_and_role_mismatches_fail(self):
        pin = self.pin()
        for change in ({"bytes": closure.MAX_FILE + 1}, {"bytes": True}, {"sha256": "a" * 63},
                       {"gitBlob": "f" * 39}, {"language": "java"}, {"role": "generator-input"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                closure.validate_pins([{**pin, **change}], True)

    def test_existing_source_is_reverified_by_git_blob_and_sha(self):
        data = b"package probe\n"
        pin = self.pin(data)
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory)
            target = output / "sources" / pin["path"]
            target.parent.mkdir(parents=True)
            target.write_bytes(data)
            self.assertEqual(closure.prepare_file(pin, output, None, True), pin)
            target.write_bytes(b"package other\n")
            with self.assertRaisesRegex(ValueError, "Git blob mismatch"):
                closure.prepare_file(pin, output, None, True)

    def test_oversized_source_and_symlinks_are_rejected(self):
        pin = self.pin()
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "output"
            target = output / "sources" / pin["path"]
            target.parent.mkdir(parents=True)
            target.write_bytes(b"x" * (pin["bytes"] + 1))
            with self.assertRaises(ValueError):
                closure.prepare_file(pin, output, None, True)
            target.unlink()
            elsewhere = pathlib.Path(directory) / "Elsewhere.kt"
            elsewhere.write_bytes(b"package probe\n")
            target.symlink_to(elsewhere)
            with self.assertRaises(ValueError):
                closure.prepare_file(pin, output, None, True)
            target.unlink()
            target.parent.rmdir()
            target.parent.symlink_to(elsewhere.parent, target_is_directory=True)
            with self.assertRaises(ValueError):
                closure.prepare_file(pin, output, None, True)


if __name__ == "__main__":
    unittest.main()
