import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("tool_host_build", Path(__file__).with_name("build.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PrivateBuildTests(unittest.TestCase):
    def test_ninja_shell_suffix_is_never_executed(self):
        self.assertEqual(builder.compiler_command(
            ': && /sdk/bin/clang++ "file with spaces.a" -o bin/llvm && cd /cache && touch existing'
        ), ["/sdk/bin/clang++", "file with spaces.a", "-o", "bin/llvm"])
        with self.assertRaises(ValueError):
            builder.compiler_command("sh -c destructive-command")
        with self.assertRaises(ValueError):
            builder.compiler_command("/sdk/bin/clang++ @mutable.rsp")

    def test_compile_rewrites_every_output(self):
        result = builder.private_compile([
            "/sdk/bin/clang++", "-I/cache/include", "-MD", "-MT", "cache.obj",
            "-MF", "cache.d", "-o", "cache.obj", "-c", "/cache/Program.cpp"
        ], Path("/private/Program.cpp"), Path("/private/Program.cpp.obj"))
        self.assertNotIn("cache.obj", result)
        self.assertNotIn("cache.d", result)
        self.assertNotIn("/cache/Program.cpp", result)
        self.assertIn("-DLLVM_WASM_IDLE_TOOL_HOST=1", result)
        self.assertEqual(result[-4:], ["-c", "/private/Program.cpp", "-o", "/private/Program.cpp.obj"])

    def test_link_reads_cached_inputs_and_writes_only_private_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "lib").mkdir()
            support = root / builder.ARCHIVE
            support.write_bytes(b"archive unchanged")
            obj = root / "file with spaces.obj"
            obj.write_bytes(b"object unchanged")
            expected = {path: builder.identity(path) for path in [support, obj]}
            result, inputs = builder.private_link([
                "/sdk/bin/clang++", "-o", "bin/llvm", str(obj), builder.ARCHIVE
            ], root, Path("/private/libLLVMSupport.a"), Path("/private/clang.wasm"), 2)
            self.assertNotIn("bin/llvm", result)
            self.assertIn("/private/libLLVMSupport.a", result)
            self.assertIn("--no-wasm-opt", result)
            self.assertIn("-Wl,--threads=2", result)
            self.assertEqual(set(inputs), {support, obj})
            self.assertEqual({path: builder.identity(path) for path in inputs}, expected)

    def test_missing_or_duplicate_support_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "lib").mkdir()
            (root / builder.ARCHIVE).write_bytes(b"archive")
            for inputs in [[], [builder.ARCHIVE, builder.ARCHIVE], ["missing.obj", builder.ARCHIVE]]:
                with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                    builder.private_link(["/sdk/bin/clang++", *inputs], root,
                                         root / "private.a", root / "out.wasm", 1)

    def test_lld_repeated_archive_order_is_preserved_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "lib").mkdir()
            (root / builder.ARCHIVE).write_bytes(b"archive")
            result, _ = builder.private_link(
                ["/sdk/bin/clang++", builder.ARCHIVE, "-lpthread", builder.ARCHIVE],
                root, root / "private.a", root / "out.wasm", 1,
                expected_support_occurrences=2)
            self.assertEqual(result[1:4], [str(root / "private.a"), "-lpthread", str(root / "private.a")])

    def test_output_cannot_overlap_or_replace_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            for output in [root, source, source / "candidate"]:
                with self.subTest(output=output), self.assertRaises(ValueError):
                    builder.validate_output(output, [source])
            alias = root / "alias"
            alias.symlink_to(source)
            with self.assertRaises(ValueError):
                builder.validate_output(alias / "candidate", [source])
            builder.validate_output(root / "new-private", [source])


if __name__ == "__main__":
    unittest.main()
