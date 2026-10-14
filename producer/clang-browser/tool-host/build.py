#!/usr/bin/env python3
"""Relink a private exec_v1 candidate from an explicitly selected LLVM build.

Cached source, objects, archives and binaries are read-only inputs. This helper
does not invoke Ninja's build mode, download tools, or publish a distribution.
"""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import resource
import shlex
import shutil
import signal
import subprocess
import time


HERE = Path(__file__).resolve().parent
PROGRAM = Path("llvm/lib/Support/Program.cpp")
OBJECT = "lib/Support/CMakeFiles/LLVMSupport.dir/Program.cpp.obj"
ARCHIVE = "lib/libLLVMSupport.a"


def identity(path):
    path = Path(path)
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def capture(argv, cwd=None):
    return subprocess.check_output(argv, cwd=cwd, text=True).strip()


def compiler_command(text):
    """Accept the pinned Ninja compile/link grammar; never execute shell text."""
    words = shlex.split(text)
    if words[:2] == [":", "&&"]:
        words = words[2:]
    if "&&" in words:
        words = words[:words.index("&&")]
    if not words or Path(words[0]).name != "clang++":
        raise ValueError("expected a direct WASI SDK clang++ command")
    if any(word in {";", "|", "||", ">", "<", "&"} for word in words):
        raise ValueError("unexpected shell operator in compiler command")
    if any(word.startswith("@") for word in words):
        raise ValueError("response files in cached build commands are unsupported")
    return words


def private_compile(argv, source, output):
    result = []
    skip = False
    for word in argv:
        if skip:
            skip = False
            continue
        if word in {"-o", "-MF", "-MT", "-MQ", "-c"}:
            skip = True
        elif word not in {"-MD", "-MMD"}:
            result.append(word)
    return result + ["-DLLVM_WASM_IDLE_TOOL_HOST=1", "-c", str(source), "-o", str(output)]


def private_link(argv, build, archive, output, threads, expected_support_occurrences=1,
                 lto_opt_level=None, lto_codegen_level=None):
    result, inputs = [], []
    skip = False
    support_count = 0
    for word in argv:
        if skip:
            skip = False
            continue
        if word == "-o":
            skip = True
            continue
        if word.endswith((".a", ".obj", ".o")) and not word.startswith("-"):
            original = (build / word).resolve()
            if not original.is_file():
                raise ValueError(f"missing cached input: {original}")
            inputs.append(original)
            if original == (build / ARCHIVE).resolve():
                result.append(str(archive))
                support_count += 1
            else:
                result.append(str(original))
        else:
            result.append(word)
    if support_count != expected_support_occurrences:
        raise ValueError(f"expected {expected_support_occurrences} LLVMSupport archive reference(s)")
    # Avoid SDK's implicit invocation of a mutable wasm-opt on PATH.
    options = [
        "--no-wasm-opt", "-Wl,--keep-section=target_features",
        f"-Wl,--threads={threads}", f"-Wl,--thinlto-jobs={threads}",
        "-Wl,--lto-partitions=1",
    ]
    if lto_opt_level is not None:
        options.append(f"-Wl,--lto-O{lto_opt_level}")
    if lto_codegen_level is not None:
        options.append(f"-Wl,--lto-CGO{lto_codegen_level}")
    return result + options + ["-o", str(output)], sorted(set(inputs))


def validate_output(output, protected):
    output = output.resolve()
    for root in protected:
        root = root.resolve()
        if output == root or output in root.parents or root in output.parents:
            raise ValueError(f"output overlaps a read-only input: {root}")
    if output.exists():
        raise ValueError("output must not exist; failed builds are preserved")


class CommandFailure(RuntimeError):
    def __init__(self, result):
        self.result = result
        super().__init__(f"{Path(result['argv'][0]).name}: {result['termination']} "
                         f"(exit {result['exitCode']}, {result['durationSeconds']} s)")


def run_bounded(argv, cwd, timeout, address_space_bytes, threads):
    def limits():
        resource.setrlimit(resource.RLIMIT_AS, (address_space_bytes, address_space_bytes))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    started = time.monotonic()
    env = {**os.environ, "BINARYEN_CORES": str(threads)}
    child = subprocess.Popen(argv, cwd=cwd, env=env, start_new_session=True,
                             preexec_fn=limits)
    termination = "exited"
    try:
        while True:
            pid, status, usage = os.wait4(child.pid, os.WNOHANG)
            if pid:
                break
            if time.monotonic() - started >= timeout:
                termination = "timeout"
                os.killpg(child.pid, signal.SIGKILL)
                _, status, usage = os.wait4(child.pid, 0)
                break
            time.sleep(0.05)
        child.returncode = os.waitstatus_to_exitcode(status)
    except BaseException:
        if child.returncode is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        raise
    result = {
        "argv": argv, "durationSeconds": round(time.monotonic() - started, 3),
        "exitCode": child.returncode,
        "termination": "signal" if child.returncode < 0 and termination == "exited" else termination,
        "usage": {"maximumResidentSetBytes": usage.ru_maxrss * 1024,
                  "userCpuSeconds": usage.ru_utime, "systemCpuSeconds": usage.ru_stime,
                  "scope": "Linux wait4 child accounting; not an aggregate process-tree memory limit"},
    }
    if child.returncode:
        raise CommandFailure(result)
    return result


def build(args):
    source, cached, output, wasm_opt = (
        value.resolve() for value in (args.source, args.build, args.output, args.wasm_opt)
    )
    profile = json.loads((HERE / "profile.json").read_text())
    manifest = json.loads((HERE.parent / "manifest.json").read_text())
    patch = HERE / profile["patch"]["path"]
    if identity(patch)["sha256"] != profile["patch"]["sha256"]:
        raise ValueError("profile patch digest mismatch")
    cwd_source = HERE / profile["initialCwd"]["path"]
    if identity(cwd_source)["sha256"] != profile["initialCwd"]["sha256"]:
        raise ValueError("profile cwd initializer digest mismatch")
    if identity(source / PROGRAM)["sha256"] != profile["baselineProgramSha256"]:
        raise ValueError("cached Program.cpp differs from the pinned patch input")
    revision = capture(["git", "rev-parse", "HEAD"], source)
    if revision != profile["llvmCommit"] or revision != manifest["sources"]["llvm"]["commit"]:
        raise ValueError("cached source revision does not match the profile/producer")
    compile_argv = compiler_command(capture(["ninja", "-t", "commands", "-s", OBJECT], cached))
    link_argv = compiler_command(capture(["ninja", "-t", "commands", "-s", "bin/llvm"], cached))
    lld_argv = compiler_command(capture(["ninja", "-t", "commands", "-s", "bin/lld"], cached))
    if compile_argv[0] != link_argv[0] or "--target=wasm32-wasip1" not in compile_argv:
        raise ValueError("expected the same wasm32-wasip1 compiler for compile/link")
    sdk = Path(compile_argv[0]).resolve().parent.parent
    validate_output(output, [source, cached, sdk, wasm_opt.parent])
    if identity(wasm_opt)["sha256"] != args.wasm_opt_sha256:
        raise ValueError("explicit wasm-opt digest mismatch")
    if shutil.disk_usage(output.parent).free < 768 * 1024 * 1024:
        raise ValueError("at least 768 MiB free space required before a private relink")
    overlay = output / "source-pack"
    patched_source = overlay / PROGRAM
    private_archive = output / "libLLVMSupport.a"
    object_path = output / "Program.cpp.obj"
    cwd_object = output / "initial-cwd.obj"
    compile_private = private_compile(compile_argv, patched_source, object_path)
    links = {}
    link_inputs = []
    for name, argv in [("clang", link_argv), ("lld", lld_argv)]:
        command, inputs = private_link(argv, cached, private_archive, output / f"{name}.raw.wasm", args.threads,
                                      expected_support_occurrences=2 if name == "lld" else 1,
                                      lto_opt_level=args.lto_opt_level,
                                      lto_codegen_level=args.lto_codegen_level)
        links[name] = command + [str(cwd_object)]
        link_inputs.extend(inputs)
    original_files = sorted(set(link_inputs + [source / PROGRAM, cached / OBJECT, cached / "bin/llvm", cached / "bin/lld"]))
    originals = {str(path): identity(path) for path in original_files}
    plan = {
        "schemaVersion": 1, "profile": profile,
        "qualification": "local incremental candidate; not a distribution lock",
        "optimization": "none" if args.skip_optimize else "Oz",
        "linkTimeOptimization": {
            "mode": "thin" if "-flto=thin" in compile_argv else "full" if "-flto" in compile_argv or "-flto=full" in compile_argv else "unspecified",
            "optimizerLevelOverride": args.lto_opt_level,
            "codegenLevelOverride": args.lto_codegen_level,
            "partitions": 1,
            "thinLtoCache": None,
        },
        "source": {"revision": revision, "repository": manifest["sources"]["llvm"]["repository"]},
        "producerManifest": identity(HERE.parent / "manifest.json"),
        "inputs": originals,
        "tools": {
            "compiler": {"path": compile_argv[0], **identity(compile_argv[0]),
                         "version": capture([compile_argv[0], "--version"])},
            "wasmOpt": {"path": str(wasm_opt), **identity(wasm_opt),
                        "version": capture([str(wasm_opt), "--version"])},
        },
        "limits": {"threads": args.threads,
                   "addressSpaceBytesPerProcess": args.address_space_gib * 1024**3,
                   "addressSpaceEnforcement": "inherited RLIMIT_AS; virtual address space, not RSS or process-tree total",
                   "coreDumpBytes": 0,
                   "timeoutSecondsPerChild": args.timeout_seconds},
        "commands": [],
    }
    if args.plan_only:
        print(json.dumps({**plan, "compile": compile_private, "links": links}, indent=2))
        return
    output.mkdir(mode=0o700)
    patched_source.parent.mkdir(parents=True)
    shutil.copyfile(source / PROGRAM, patched_source)
    shutil.copyfile(source / PROGRAM, overlay / "Program.original.cpp")
    shutil.copyfile(source / "llvm/LICENSE.TXT", overlay / "LICENSE.LLVM.txt")
    for name in ["llvm-tool-host.patch", "profile.json", "build.py", "README.md", "verify.mjs", "initial-cwd.c"]:
        shutil.copyfile(HERE / name, overlay / name)
    # Preserve producer modifications separately from the new exec_v1 patch.
    with (overlay / "baseline-source.diff").open("wb") as stream:
        subprocess.run(["git", "diff", "--binary", "HEAD"], cwd=source, stdout=stream, check=True)
    (overlay / "upstream.json").write_text(json.dumps(manifest["sources"], indent=2) + "\n")
    receipt = output / "build-receipt.json"
    phase_file = output / "phase.json"

    def phase(name):
        phase_file.write_text(json.dumps({"phase": name, "pid": os.getpid()}) + "\n")
        receipt.write_text(json.dumps(plan, indent=2) + "\n")

    def execute(argv):
        try:
            result = run_bounded(argv, output, args.timeout_seconds,
                                 args.address_space_gib * 1024**3, args.threads)
        except CommandFailure as error:
            plan["commands"].append(error.result)
            raise
        plan["commands"].append(result)

    try:
        phase("patch")
        # git apply only sees the private overlay, never the cache checkout.
        execute(["git", "-C", str(overlay), "apply", str(patch)])
        phase("compile")
        execute(compile_private)
        execute([str(Path(compile_argv[0]).parent / "clang"), "--target=wasm32-wasip1",
                 "-Oz", "-flto", "-c", str(overlay / "initial-cwd.c"), "-o", str(cwd_object)])
        shutil.copyfile(cached / ARCHIVE, private_archive)
        archive_tool = str(Path(compile_argv[0]).parent / "llvm-ar")
        members = capture([archive_tool, "t", str(private_archive)]).splitlines()
        if members.count("Program.cpp.obj") != 1:
            raise ValueError("ambiguous Program.cpp.obj archive member")
        execute([archive_tool, "r", str(private_archive), str(object_path)])
        output_names = []
        for name, link_private in links.items():
            raw_wasm = output / f"{name}.raw.wasm"
            final_wasm = output / f"{name}.wasm"
            phase(f"link:{name}")
            execute(link_private)
            if args.skip_optimize:
                shutil.copyfile(raw_wasm, final_wasm)
            else:
                phase(f"optimize:{name}")
                execute([str(wasm_opt), "-Oz", str(raw_wasm), "-o", str(final_wasm)])
            phase(f"verify:{name}")
            execute(["node", str(overlay / "verify.mjs"), str(final_wasm),
                     str(output / f"{name}.module.json"), "--initial-cwd", f"--kind={name}"])
            with final_wasm.open("rb") as stream, (output / f"{name}.wasm.gz").open("wb") as compressed:
                with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0, compresslevel=9) as target:
                    shutil.copyfileobj(stream, target)
            output_names.extend([f"{name}.raw.wasm", f"{name}.wasm", f"{name}.wasm.gz", f"{name}.module.json"])
        for path, expected in originals.items():
            if identity(path) != expected:
                raise ValueError(f"read-only input changed during build: {path}")
        plan["readOnlyInputsUnchanged"] = True
        plan["outputs"] = {name: identity(output / name) for name in output_names}
        plan["sourcePack"] = {str(path.relative_to(overlay)): identity(path)
                              for path in sorted(overlay.rglob("*")) if path.is_file()}
        plan["complete"] = True
        phase("complete")
    except BaseException as error:
        plan["complete"] = False
        plan["failure"] = str(error)
        phase("failed")
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--wasm-opt", type=Path, required=True)
    parser.add_argument("--wasm-opt-sha256", required=True)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--address-space-gib", "--memory-gib", dest="address_space_gib", type=int, default=10,
                        help="per-process inherited RLIMIT_AS in GiB; not resident RAM or a process-tree total")
    parser.add_argument("--lto-opt-level", type=int, choices=range(4),
                        help="explicit link-time optimizer level; default preserves cached command")
    parser.add_argument("--lto-codegen-level", type=int, choices=range(4),
                        help="explicit link-time codegen level; default preserves cached command")
    parser.add_argument("--timeout-seconds", type=int, default=2700)
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument("--skip-optimize", action="store_true", help="retain raw links for the first CLI gate")
    args = parser.parse_args()
    if not 1 <= args.threads <= 4 or not 1 <= args.address_space_gib <= 16 or not 1 <= args.timeout_seconds <= 14400:
        parser.error("limits outside allowed bounds (threads 1..4, GiB 1..16, timeout 1..14400)")
    build(args)


if __name__ == "__main__":
    main()
