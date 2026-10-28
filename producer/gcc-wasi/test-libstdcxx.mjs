#!/usr/bin/env node
// Actual GCC17 -> WABT -> wasm-ld -> WASI execution. Requires build-libstdcxx.sh.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const work = path.resolve(process.env.GCC_WASI_WORK_DIR ?? "");
assert.ok(process.env.GCC_WASI_WORK_DIR, "Set GCC_WASI_WORK_DIR");
const runtime = path.resolve(
  process.env.GCC_LIBSTDCXX_WORK_DIR ?? path.join(work, "libstdcxx"),
);
const output = path.resolve(
  process.argv[2] ?? path.join(runtime, `qualification-${Date.now()}`),
);
mkdirSync(output); // Never overwrite earlier evidence.
const identity = (file) => {
  const bytes = readFileSync(file);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};
const build = JSON.parse(
  readFileSync(path.join(runtime, "build.json"), "utf8"),
);
function checkCompilerIdentity() {
  for (const tool of ["cc1", "cc1plus", "xgcc"])
    assert.equal(
      identity(path.join(work, "gcc-native/gcc", tool)).sha256,
      build.nativeCompiler[tool],
      `GCC ${tool} differs from the compiler that built libstdc++`,
    );
}
checkCompilerIdentity();
const include = path.join(runtime, "install/include/c++/17.0.0");
const configured = readdirSync(include, { withFileTypes: true }).filter(
  (entry) => entry.isDirectory() && entry.name.startsWith("wasm32-"),
);
assert.equal(
  configured.length,
  1,
  "Expected one GCC target configuration include directory",
);
const compiler = path.join(runtime, "driver/g++");
const common = [
  "-O0",
  "-g0",
  "-std=gnu++20",
  "-fno-exceptions",
  "-fno-rtti",
  "-fuse-cxa-atexit",
  "-fno-threadsafe-statics",
  "-nostdinc++",
  "-I" + include,
  "-I" + path.join(include, configured[0].name),
  "-DONLINE_JUDGE=1",
];
const cases = [
  {
    id: "stl-static-multiple",
    stdin: "4 9 1 5 3\n",
    stdout: "17 18 1 9 gcc-wasi\n",
    files: {
      "sum.h": "#include <vector>\nint sum(const std::vector<int>&);\n",
      "sum.cpp":
        '#include "sum.h"\n#include <numeric>\n#ifndef ONLINE_JUDGE\n#error missing ONLINE_JUDGE\n#endif\nint sum(const std::vector<int>& v) { return std::accumulate(v.begin(), v.end(), 0); }\n',
      "main.cpp":
        '#include "sum.h"\n#include <algorithm>\n#include <string>\n#include <cstdio>\n#ifndef ONLINE_JUDGE\n#error missing ONLINE_JUDGE\n#endif\nint marker; struct Init { Init() { marker=17; } }; Init global; std::vector<int> initial={7,3,2};\nint main() { int n; if (scanf("%d",&n)!=1) return 1; std::vector<int> values(n); for(int& v:values) if(scanf("%d",&v)!=1) return 2; std::sort(values.begin(),values.end()); std::string text="gcc-"; text+="wasi"; if(initial.size()!=3) return 3; printf("%d %d %d %d %s\\n",marker,sum(values),values.front(),values.back(),text.c_str()); }\n',
    },
    sources: ["main.cpp", "sum.cpp"],
  },
  {
    id: "iostream",
    stdin: "44\n",
    stdout: "45\n",
    files: {
      "main.cpp":
        '#include <iostream>\nint main() { int n; if (!(std::cin>>n)) return 1; std::cout<<n+1<<"\\n"; }\n',
    },
    sources: ["main.cpp"],
  },
];
const runner = `
import { WASI } from 'node:wasi';
import { openSync, readFileSync } from 'node:fs';
const [wasm,input,output,error]=process.argv.slice(1);
const wasi=new WASI({version:'preview1',args:['program.wasm'],env:{},preopens:{},stdin:openSync(input,'r'),stdout:openSync(output,'w'),stderr:openSync(error,'w'),returnOnExit:true});
const module=await WebAssembly.compile(readFileSync(wasm));
const instance=await WebAssembly.instantiate(module,{wasi_snapshot_preview1:wasi.wasiImport});
process.exitCode=wasi.start(instance);
`;
const report = {
  schemaVersion: 1,
  status: "running",
  compiler: "gcc",
  gccCommit: build.gccCommit,
  target: "wasm32-wasi",
  buildReceipt: identity(path.join(runtime, "build.json")),
  testRecipe: identity(fileURLToPath(import.meta.url)),
  cases: [],
};
try {
  for (const test of cases) {
    const directory = path.join(output, test.id);
    mkdirSync(directory);
    for (const [name, contents] of Object.entries(test.files))
      writeFileSync(path.join(directory, name), contents);
    const args = [
      ...common,
      ...test.sources,
      "-L" + path.join(runtime, "install/lib"),
      "-lstdc++",
      "-o",
      "program.wasm",
    ];
    const compiled = spawnSync(compiler, args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(
      path.join(directory, "compile.stdout"),
      compiled.stdout ?? "",
    );
    writeFileSync(
      path.join(directory, "compile.stderr"),
      compiled.stderr ?? String(compiled.error ?? ""),
    );
    assert.equal(
      compiled.status,
      0,
      `${test.id}: GCC/libstdc++ compilation failed: ${compiled.stderr}`,
    );
    const wasm = path.join(directory, "program.wasm");
    const module = await WebAssembly.compile(readFileSync(wasm));
    const imports = WebAssembly.Module.imports(module),
      exports = WebAssembly.Module.exports(module);
    assert.ok(
      imports.every(
        (entry) =>
          entry.module === "wasi_snapshot_preview1" &&
          entry.kind === "function",
      ),
    );
    assert.ok(
      exports.some(
        (entry) => entry.name === "memory" && entry.kind === "memory",
      ),
    );
    assert.ok(
      exports.some(
        (entry) => entry.name === "_start" && entry.kind === "function",
      ),
    );
    const input = path.join(directory, "stdin.txt"),
      stdout = path.join(directory, "stdout.txt"),
      stderr = path.join(directory, "stderr.txt");
    writeFileSync(input, test.stdin);
    const executed = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", runner, wasm, input, stdout, stderr],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(
      executed.status,
      0,
      `${test.id}: WASI execution failed: ${executed.stderr}`,
    );
    assert.equal(
      readFileSync(stdout, "utf8"),
      test.stdout,
      `${test.id}: unexpected stdout`,
    );
    assert.equal(
      readFileSync(stderr, "utf8"),
      "",
      `${test.id}: unexpected stderr`,
    );
    report.cases.push({
      id: test.id,
      status: "passed",
      command: [compiler, ...args],
      source: Object.fromEntries(
        test.sources.map((name) => [
          name,
          identity(path.join(directory, name)),
        ]),
      ),
      artifact: identity(wasm),
      imports,
      exports,
      exitCode: executed.status,
      stdout: test.stdout,
    });
  }
  report.unsupported = [];
  for (const test of [
    {
      feature: "timezoneDatabase",
      flags: [],
      code: "#include <chrono>\nint main() { return std::chrono::get_tzdb().zones.empty(); }\n",
      diagnostic: /undefined symbol:.*get_tzdb/,
    },
    {
      feature: "debugger",
      flags: ["-std=gnu++26"],
      code: "#include <debugging>\nint main() { return std::is_debugger_present(); }\n",
      diagnostic: /undefined symbol:.*is_debugger_present/,
    },
    {
      feature: "stdModules",
      flags: ["-fmodules"],
      code: "import std;\nint main() { return 0; }\n",
      diagnostic: /failed to read compiled module/,
    },
  ]) {
    const unsupported = path.join(output, test.feature + "-unsupported");
    mkdirSync(unsupported);
    writeFileSync(path.join(unsupported, "main.cpp"), test.code);
    const unavailable = spawnSync(
      compiler,
      [
        ...common,
        ...test.flags,
        "main.cpp",
        "-L" + path.join(runtime, "install/lib"),
        "-lstdc++",
        "-o",
        "program.wasm",
      ],
      {
        cwd: unsupported,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    writeFileSync(
      path.join(unsupported, "compile.stderr"),
      unavailable.stderr ?? "",
    );
    assert.notEqual(
      unavailable.status,
      0,
      `Unsupported ${test.feature} unexpectedly linked`,
    );
    assert.match(unavailable.stderr ?? "", test.diagnostic);
    report.unsupported.push({
      feature: test.feature,
      status: "rejected",
      exitCode: unavailable.status,
    });
  }
  checkCompilerIdentity();
  report.status = "passed";
  // A completed native execution receipt gates the producer's optional runtime merge.
  // Preserve prior qualified output instead of mutating a bundle another build may use.
  const bundle = path.join(runtime, "sysroot");
  assert.ok(
    !existsSync(bundle),
    "Qualified runtime sysroot already exists; choose a fresh runtime output",
  );
  const files = [];
  function installFile(source, relative) {
    assert.ok(
      lstatSync(source).isFile(),
      `Runtime file must be regular: ${source}`,
    );
    const destination = path.join(bundle, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    files.push({ path: relative, ...identity(destination) });
  }
  function installHeaders(source, relative) {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const filename = path.join(source, entry.name),
        destination = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) installHeaders(filename, destination);
      else installFile(filename, destination);
    }
  }
  installHeaders(path.join(runtime, "install/include"), "include");
  for (const library of ["libstdc++.a", "libsupc++.a"])
    installFile(
      path.join(runtime, "install/lib", library),
      `lib/wasm32-wasi/${library}`,
    );
  files.sort((left, right) => left.path.localeCompare(right.path));
  report.runtimeFiles = files.length;
  report.qualifiedRuntime = bundle;
  report.runtimeReceipt = path.join(runtime, "libstdcxx-build.json");
  writeFileSync(
    path.join(output, "qualification.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  writeFileSync(
    report.runtimeReceipt,
    JSON.stringify(
      {
        schemaVersion: 1,
        status: "passed",
        target: "wasm32-wasi",
        gccCommit: build.gccCommit,
        version: "17.0.0",
        exceptions: false,
        rtti: false,
        threads: false,
        timezoneDatabase: false,
        debugger: false,
        stdModules: false,
        buildReceipt: {
          path: "build.json",
          ...identity(path.join(runtime, "build.json")),
        },
        qualification: {
          path: path.relative(runtime, path.join(output, "qualification.json")),
          ...identity(path.join(output, "qualification.json")),
        },
        recipe: build.recipe,
        patch: build.patch,
        errnoPatch: build.errnoPatch,
        errnoHeader: build.errnoHeader,
        files,
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  writeFileSync(
    path.join(output, "qualification.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: report.status,
      passed: report.cases.length,
      report: path.join(output, "qualification.json"),
      ...(report.error ? { error: report.error } : {}),
    }),
  );
}
