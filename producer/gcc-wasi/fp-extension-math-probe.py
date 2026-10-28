#!/usr/bin/env python3
"""Measure libstdc++ math linkage with real Wasm function declarations.

Autoconf's generic char fn() checks are invalid for typed Wasm imports. These
probes keep declarations from math.h/stdlib.h and a live volatile function pointer;
no target source is rewritten and no math implementation is supplied.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

def identity(path):
    path = Path(path)
    data = path.read_bytes()
    return {"path": str(path), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}

def tree(root):
    root = Path(root)
    return {str(p.relative_to(root)): identity(p) for p in sorted(root.rglob("*")) if p.is_file()}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--work")
parser.add_argument("--sdk")
parser.add_argument("--source")
parser.add_argument("--target-headers")
parser.add_argument("--output", required=True)
parser.add_argument("--verify", action="store_true")
args = parser.parse_args()
output = Path(args.output).resolve()
report_file = output / "report.json"

if args.verify:
    report = json.loads(report_file.read_text())
    assert report["status"] == "passed" and report["inputsUnchanged"]
    for item in report["inputs"].values():
        assert identity(item["path"]) == item, item["path"]
    for name, saved in report["headers"].items():
        assert tree(report["headerRoots"][name]) == saved, name
    for item in report["artifacts"]:
        assert identity(item["path"]) == item, item["path"]
    print("Typed math probes verified:", report["counts"])
    sys.exit(0)

for key in ("work", "sdk", "source", "target_headers"):
    if not getattr(args, key):
        parser.error("--" + key.replace("_", "-") + " is required")
work, sdk, source, target_headers = (Path(getattr(args, k)).resolve()
                                   for k in ("work", "sdk", "source", "target_headers"))
output.mkdir()  # Preserve every previous probe, including failure evidence.
linkage = source / "linkage.m4"
text = linkage.read_text()
stdlib_functions = set(re.findall(r"GLIBCXX_CHECK_STDLIB_DECL_AND_LINKAGE_[123]\((\w+)\)", text))
text = text.split("AC_DEFUN([GLIBCXX_CHECK_MATH_SUPPORT], [", 1)[1]
functions = set(re.findall(r"GLIBCXX_CHECK_MATH_DECL_AND_LINKAGE_[123]\((\w+)\)", text))
for group in re.findall(r"GLIBCXX_CHECK_MATH_DECLS_AND_LINKAGES_1\([^,]+,[^,]+,([^)]*)\)", text):
    functions.update(re.findall(r"\b[a-z][a-z0-9_]*\b", group.replace("\\", "")))
functions.add("sin")  # Also replace the generic AC_CHECK_LIB(m, sin) test.
functions.update(stdlib_functions)
required = set()
stub_sources = {}
for suffix in ("float", "long_double"):
    file = source / "src/c++98" / ("math_stubs_" + suffix + ".cc")
    required.update(name.lower() for name in re.findall(r"#ifndef _GLIBCXX_HAVE_(\w+)", file.read_text()))
    stub_sources[suffix] = file
assert len(functions) > 40 and required <= functions, (functions, required - functions)
sysroot = sdk / "share/wasi-sysroot"
library = sysroot / "lib/wasm32-wasi"
tools = {"compiler": work / "gcc-native/gcc/cc1",
         "assembler": work / "wabt-native/wat2wasm", "linker": sdk / "bin/wasm-ld"}
inputs = {"recipe": Path(__file__).resolve(), "linkage": linkage, **stub_sources, **tools,
          "crt": library / "crt1-command.o", "libc": library / "libc.a", "libm": library / "libm.a",
          "builtins": sdk / "lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a"}
header_roots = {"gcc": work / "gcc-native/gcc/include",
                "target": target_headers / "include", "sdk": sysroot / "include"}
report = {"schemaVersion": 1, "kind": "gcc-wasi-typed-math-link-probes",
          "status": "running", "target": "wasm32-wasi",
          "method": "math.h/stdlib.h declared function type, live volatile function pointer, actual GCC/WABT/fatal-warning LLD link",
          "functions": sorted(functions), "requiredToAvoidMathStubs": sorted(required),
          "stdlibFunctions": sorted(stdlib_functions),
          "inputs": {k: identity(v) for k, v in inputs.items()},
          "headerRoots": {k: str(v) for k, v in header_roots.items()},
          "headers": {k: tree(v) for k, v in header_roots.items()}, "cases": [], "artifacts": []}

def save():
    report_file.write_text(json.dumps(report, indent=2) + "\n")

def run(argv, directory):
    try:
        r = subprocess.run([str(a) for a in argv], cwd=directory, capture_output=True,
                           text=True, timeout=60)
        return {"argv": [str(a) for a in argv], "exitCode": r.returncode,
                "stdout": r.stdout, "stderr": r.stderr}
    except subprocess.TimeoutExpired as error:
        return {"argv": [str(a) for a in argv], "exitCode": None, "error": str(error)}

save()
for function in sorted(functions):
    directory = output / function
    directory.mkdir()
    c = directory / "probe.c"
    wat, obj, program = (directory / name for name in ("probe.wat", "probe.o", "probe.wasm"))
    c.write_text(("#include <stdlib.h>\n" if function in stdlib_functions else "#include <math.h>\n") +
                 "static __typeof__(&" + function + ") volatile pointer = &" + function + ";\n"
                 "int fp_math_probe(void) { return pointer != 0; }\n"
                 "int main(void) { return !fp_math_probe(); }\n")
    commands = [
        [tools["compiler"], "-quiet", "-O0", "-std=gnu11", "-fno-builtin", "-D_GNU_SOURCE",
         "-D__GCC_WASI_SINGLE_THREAD__=1", "-nostdinc",
         "-isystem", header_roots["gcc"],
         "-isystem", header_roots["target"] / "wasm32-wasi",
         "-isystem", sysroot / "include/wasm32-wasi", "-isystem", sysroot / "include",
         c, "-o", wat],
        [tools["assembler"], "-r", "--enable-annotations", wat, "-o", obj],
        [tools["linker"], "--fatal-warnings", "-m", "wasm32", "-e", "_start",
         "--export=fp_math_probe", "-o", program, inputs["crt"], obj,
         "-L" + str(library), "-lm", "-lc", inputs["builtins"]],
    ]
    entry = {"function": function, "required": function in required, "commands": []}
    for command in commands:
        result = run(command, directory)
        entry["commands"].append(result)
        if result["exitCode"] != 0:
            break
    entry["available"] = len(entry["commands"]) == 3 and entry["commands"][-1]["exitCode"] == 0
    entry["artifacts"] = [identity(p) for p in (c, wat, obj, program) if p.is_file()]
    report["cases"].append(entry)
    report["artifacts"].extend(entry["artifacts"])
    save()

answers = {entry["function"]: "yes" if entry["available"] else "no" for entry in report["cases"]}
cache = output / "config.site"
cache.write_text("# Measured typed GCC/WABT/LLD linkage; see adjacent report.json.\n" +
                 "".join("ac_cv_func_" + name + "=" + answers[name] + "\n" for name in sorted(answers)) +
                 "ac_cv_lib_m_sin=" + answers["sin"] + "\n")
report["cache"] = identity(cache)
report["artifacts"].append(report["cache"])
report["counts"] = {"total": len(answers), "available": sum(v == "yes" for v in answers.values()),
                    "unavailable": sum(v == "no" for v in answers.values())}
report["missingRequired"] = sorted(name for name in required if answers[name] != "yes")
report["inputsUnchanged"] = (
    {k: identity(v) for k, v in inputs.items()} == report["inputs"]
    and {k: tree(v) for k, v in header_roots.items()} == report["headers"])
report["status"] = "passed" if report["inputsUnchanged"] and not report["missingRequired"] else "failed"
save()
print(json.dumps({"status": report["status"], "counts": report["counts"],
                  "missingRequired": report["missingRequired"]}))
sys.exit(0 if report["status"] == "passed" else 1)
