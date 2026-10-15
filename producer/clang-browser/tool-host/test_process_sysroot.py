import argparse
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("process_sysroot", Path(__file__).with_name("process-sysroot.py"))
process = importlib.util.module_from_spec(spec)
spec.loader.exec_module(process)


def string(text):
    data = text.encode()
    return bytes([len(data)]) + data


def section(kind, payload):
    return bytes([kind, len(payload)]) + payload


def wasm_object(imports, priorities):
    entries = b"".join(string(module) + string(field) + b"\x00\x00" for module, field in imports)
    # A memory, table and global import must be skipped without being reported.
    entries += string("env") + string("memory") + b"\x02\x01\x01\x02"
    entries += string("env") + string("table") + b"\x01\x70\x00\x00"
    entries += string("env") + string("sp") + b"\x03\x7f\x01"
    imports_section = section(2, bytes([len(imports) + 3]) + entries)
    init = bytes([len(priorities)]) + b"".join(bytes([priority, 0]) for priority in priorities)
    linking = string("linking") + b"\x02" + b"\x06" + bytes([len(init)]) + init
    return b"\0asm\x01\0\0\0" + imports_section + section(0, linking)


def tar(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:", format=tarfile.USTAR_FORMAT) as archive:
        for name, data in entries:
            info = tarfile.TarInfo(name)
            info.mtime, info.mode = 0, 0o600
            if data is None:
                info.type, info.mode = tarfile.DIRTYPE, 0o700
                archive.addfile(info)
            else:
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


SYSROOT = [("lib", None), ("lib/wasm32-wasi", None), (process.CRT, b"original crt"),
           ("lib/wasm32-wasi/libc.a", b"archive bytes"), ("include", None), ("include/stdio.h", b"header")]


class ObjectProfileTests(unittest.TestCase):
    def test_reports_function_imports_and_init_priorities_only(self):
        data = wasm_object([("env", "__main_void"), ("wasm_idle_process_v1", "initial_cwd")], [101, 7])
        self.assertEqual(process.object_profile(data), {
            "functionImports": [["env", "__main_void"], ["wasm_idle_process_v1", "initial_cwd"]],
            "initPriorities": [7, 101]})

    def test_rejects_non_wasm_bytes(self):
        with self.assertRaises(ValueError):
            process.object_profile(b"\0asm\x02\0\0\0")


class ArchiveTests(unittest.TestCase):
    def test_rewrite_changes_only_crt1_and_keeps_order_and_headers(self):
        source = tar(SYSROOT)
        derived = process.rewrite(source, b"derived crt with initializer")
        self.assertEqual(process.compare(source, derived), {"directory": 3, "file": 3})
        with tarfile.open(fileobj=io.BytesIO(derived)) as archive:
            self.assertEqual(archive.getnames(), [name for name, _ in SYSROOT])
            self.assertEqual(archive.extractfile(process.CRT).read(), b"derived crt with initializer")
            self.assertEqual(archive.getmember(process.CRT).mode, 0o600)
        self.assertEqual(process.rewrite(source, b"derived crt with initializer"), derived, "deterministic bytes")

    def test_compare_rejects_any_other_change(self):
        source = tar(SYSROOT)
        other = tar([(name, b"edited" if name == "include/stdio.h" else (b"x" if name == process.CRT else data))
                     for name, data in SYSROOT])
        with self.assertRaisesRegex(ValueError, "unexpected changed entries"):
            process.compare(source, other)
        with self.assertRaisesRegex(ValueError, "unexpected changed entries"):
            process.compare(source, source)
        reordered = tar(list(reversed(SYSROOT)))
        with self.assertRaisesRegex(ValueError, "names or order"):
            process.compare(source, reordered)

    def test_unsafe_entries_are_rejected(self):
        for entries in ([("../escape", b"x")], [("/absolute", b"x")], [("a//b", b"x")],
                        [("dup", b"x"), ("dup", b"y")]):
            with self.subTest(entries=entries), tarfile.open(fileobj=io.BytesIO(tar(entries))) as archive:
                with self.assertRaises(ValueError):
                    process.safe_members(archive)
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:") as archive:
            link = tarfile.TarInfo("link")
            link.type, link.linkname = tarfile.SYMTYPE, "/etc/passwd"
            archive.addfile(link)
        with tarfile.open(fileobj=io.BytesIO(output.getvalue())) as archive, self.assertRaises(ValueError):
            process.safe_members(archive)


class BuildRefusalTests(unittest.TestCase):
    def arguments(self, root, **overrides):
        values = dict(sysroot=root / "sysroot.tar", sysroot_sha256="0" * 64, wasi_sdk=root / "sdk",
                      clang_sha256="0" * 64, wasm_ld_sha256="0" * 64, node=root / "node", output=root / "out")
        values.update(overrides)
        return argparse.Namespace(**values)

    def test_existing_output_and_wrong_sysroot_digest_fail_before_any_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sysroot.tar").write_bytes(tar(SYSROOT))
            (root / "out").mkdir()
            with self.assertRaisesRegex(ValueError, "fresh"):
                process.build(self.arguments(root))
            with self.assertRaisesRegex(ValueError, "sysroot digest"):
                process.build(self.arguments(root, output=root / "new"))
            self.assertFalse((root / "new").exists())


if __name__ == "__main__":
    unittest.main()
