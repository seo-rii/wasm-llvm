import importlib.util
import contextlib
import io
import json
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("tool_host_build", Path(__file__).with_name("build.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PrivateBuildTests(unittest.TestCase):
    def test_cli_wall_cap_is_explicit_and_default_is_unchanged(self):
        required = ["build.py", "--source", "/source", "--build", "/build",
                    "--output", "/output", "--wasm-opt", "/wasm-opt",
                    "--wasm-opt-sha256", "digest"]
        for timeout in [None, 1, 7200, 14400]:
            argv = required + ([] if timeout is None else ["--timeout-seconds", str(timeout)])
            with self.subTest(timeout=timeout), patch.object(sys, "argv", argv), patch.object(builder, "build") as build:
                builder.main()
                self.assertEqual(build.call_args.args[0].timeout_seconds, 2700 if timeout is None else timeout)

    def test_cli_rejects_out_of_range_resource_limits_before_building(self):
        required = ["build.py", "--source", "/source", "--build", "/build",
                    "--output", "/output", "--wasm-opt", "/wasm-opt",
                    "--wasm-opt-sha256", "digest"]
        for option, value in [("--timeout-seconds", 0), ("--timeout-seconds", -1),
                              ("--timeout-seconds", 14401), ("--threads", 0),
                              ("--threads", 5), ("--address-space-gib", 0),
                              ("--address-space-gib", 17)]:
            with self.subTest(option=option, value=value), patch.object(sys, "argv", required + [option, str(value)]), patch.object(builder, "build") as build:
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                    builder.main()
                self.assertEqual(caught.exception.code, 2)
                build.assert_not_called()

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
            self.assertIn("-Wl,--lto-partitions=1", result)
            self.assertFalse(any(word.startswith("-Wl,--lto-O") for word in result))
            self.assertEqual(set(inputs), {support, obj})
            self.assertEqual({path: builder.identity(path) for path in inputs}, expected)

    def test_correctness_link_uses_explicit_lto_options(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "lib").mkdir()
            (root / builder.ARCHIVE).write_bytes(b"archive")
            result, _ = builder.private_link(
                ["/sdk/bin/clang++", "-flto", builder.ARCHIVE], root,
                root / "private.a", root / "out.wasm", 1,
                lto_opt_level=1, lto_codegen_level=1)
            self.assertIn("-flto", result)
            self.assertIn("-Wl,--lto-O1", result)
            self.assertIn("-Wl,--lto-CGO1", result)
            self.assertIn("-Wl,--threads=1", result)
            self.assertFalse(any("thinlto-cache" in word for word in result))

    def test_address_space_limit_is_inherited_and_usage_is_observed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code = (
                "import json,resource,subprocess,sys; from pathlib import Path; "
                "nested=subprocess.check_output([sys.executable,'-c',"
                "'import resource; print(resource.getrlimit(resource.RLIMIT_AS)[0])'],text=True); "
                "Path('limits.json').write_text(json.dumps([resource.getrlimit(resource.RLIMIT_AS)[0],int(nested),resource.getrlimit(resource.RLIMIT_CORE)[0]]))"
            )
            result = builder.run_bounded([sys.executable, "-c", code], root, 10, 512 * 1024**2, 1)
            self.assertEqual(json.loads((root / "limits.json").read_text()), [512 * 1024**2, 512 * 1024**2, 0])
            self.assertEqual(result["exitCode"], 0)
            self.assertEqual(result["termination"], "exited")
            self.assertGreater(result["usage"]["maximumResidentSetBytes"], 0)

    def test_failed_and_timed_out_children_retain_bounded_results(self):
        for code, timeout, expected_code, termination in [
            ("raise SystemExit(7)", 10, 7, "exited"),
            ("import time; time.sleep(10)", 0.1, -signal.SIGKILL, "timeout"),
        ]:
            with self.subTest(termination=termination), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(builder.CommandFailure) as caught:
                    builder.run_bounded([sys.executable, "-c", code], directory, timeout, 512 * 1024**2, 1)
                result = caught.exception.result
                self.assertEqual(result["exitCode"], expected_code)
                self.assertEqual(result["termination"], termination)
                self.assertGreater(result["usage"]["maximumResidentSetBytes"], 0)
                self.assertNotIn(code, str(caught.exception))

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
