#!/usr/bin/env python3
"""Build and execute the real patched LLVM Support ABI contract fixture."""

import argparse
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("tool_host_build", HERE / "build.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--build", type=Path, required=True)
parser.add_argument("--candidate", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
cached, candidate, output = (path.resolve() for path in [args.build, args.candidate, args.output])
builder.validate_output(output, [cached, candidate])
compile_argv = builder.compiler_command(builder.capture(
    ["ninja", "-t", "commands", "-s", builder.OBJECT], cached))
output.mkdir(mode=0o700)
obj = output / "fixture.obj"
wasm = output / "fixture.wasm"
commands = [builder.private_compile(compile_argv, HERE / "abi-fixture.cpp", obj), [
    compile_argv[0], "--target=wasm32-wasip1", "-Oz", "-flto", "-Wl,--threads=1",
    "--no-wasm-opt", str(obj), str(candidate / "libLLVMSupport.a"),
    str(cached / "lib/libLLVMDemangle.a"), "-lwasi-emulated-mman", "-ldl", "-lpthread",
    "-o", str(wasm),
], ["node", "--disable-wasm-trap-handler", str(HERE / "abi-fixture.mjs"), str(wasm), str(output / "result.json")]]
cwd_wasm = output / "cwd-fixture.wasm"
commands.extend([
    [str(Path(compile_argv[0]).parent / "clang"), "--target=wasm32-wasip1", "-Oz", "-flto",
     "--no-wasm-opt", str(HERE / "initial-cwd.c"), str(HERE / "cwd-fixture.c"), "-o", str(cwd_wasm)],
    ["node", "--disable-wasm-trap-handler", str(HERE / "cwd-fixture.mjs"), str(cwd_wasm),
     str(output / "cwd-root"), str(output / "cwd-result.json")],
])
receipt = {
    "schemaVersion": 1,
    "inputs": {str(path): builder.identity(path) for path in [
        candidate / "libLLVMSupport.a", cached / "lib/libLLVMDemangle.a",
        HERE / "abi-fixture.cpp", HERE / "abi-fixture.mjs",
        HERE / "initial-cwd.c", HERE / "cwd-fixture.c", HERE / "cwd-fixture.mjs",
    ]},
    "commands": [],
}
for argv in commands:
    receipt["commands"].append(builder.run_bounded(argv, output, 180, 4 * 1024**3, 1))
receipt["result"] = json.loads((output / "result.json").read_text())
receipt["cwdResult"] = json.loads((output / "cwd-result.json").read_text())
receipt["modules"] = {str(path.name): builder.identity(path) for path in [wasm, cwd_wasm]}
(output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"passed": receipt["result"]["passed"], "calls": len(receipt["result"]["calls"])}))
