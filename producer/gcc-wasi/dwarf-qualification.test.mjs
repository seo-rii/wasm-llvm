import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cases, debugProfile } from './dwarf-fixtures.mjs';
import { dwarfIdentity } from './dwarf-inspect.mjs';
import {
  verifyDwarfQualificationOptions,
  verifyDwarfQualification,
  reopenDwarfQualification
} from './dwarf-qualification.mjs';

const patch = { path: 'patches/0021-dwarf-debug.patch' };
const options = {
  dwarfQualification: 'proof.json',
  nativeLinker: 'wasm-ld',
  libstdcxx: 'gnu',
  libgcov: 'gcov-runtime',
  nativeGcov: 'gcov'
};

test('a patched DWARF compiler requires the complete native and combined-runtime proof options', () => {
  verifyDwarfQualificationOptions([patch], options);
  for (const name of Object.keys(options)) {
    const missing = { ...options };
    delete missing[name];
    assert.throws(() => verifyDwarfQualificationOptions([patch], missing), new RegExp(name));
  }
});
test('older sources need no new proof; an explicitly supplied DWARF proof still requires its tools', () => {
  verifyDwarfQualificationOptions([], {});
  assert.throws(
    () => verifyDwarfQualificationOptions([], { dwarfQualification: 'proof.json' }),
    /nativeLinker/
  );
});

// Rejection-envelope tests only. These synthetic identities never constitute
// compiler, DWARF, browser, or runtime qualification evidence.
function envelope() {
  const receipt = (name) => ({
    path: '/unopened/' + name,
    bytes: 1,
    sha256: 'a'.repeat(64)
  });
  const source = { commit: 'current', patches: [patch] };
  const report = {
    schemaVersion: 1,
    kind: 'gcc-wasi-native-dwarf-qualification',
    status: 'passed',
    inputsUnchanged: true,
    artifactsUnchanged: true,
    profile: debugProfile,
    scope: {
      fullMatrix: true,
      selectedCases: cases.map((fixture) => fixture.id),
      compilerHost: 'native',
      target: 'wasm32-wasi',
      browserRunsCompiler: false
    },
    sourceLock: receipt('lock'),
    nativeBuild: receipt('native'),
    assemblerBuild: receipt('assembler'),
    gccSource: source,
    wabtSource: source,
    tools: { gcc: receipt('cc1') },
    recipes: { fixture: receipt('fixture') },
    analysisToolDependencies: [receipt('libLLVM')],
    runtime: {
      sysroot: '/target',
      gnuSysroot: '/gnu',
      includeRoots: { c: ['/target/include'], cpp: ['/gnu/include'] },
      archives: { libc: receipt('libc') },
      headers: { gcc: [receipt('header')] },
      importReceipt: receipt('import'),
      gnuBuild: receipt('gnu'),
      gnuQualification: receipt('gnu-proof'),
      coverageBuild: receipt('libgcov'),
      coverageRoot: '/coverage',
      coverageAnalysis: {
        sources: { gcov: receipt('gcov-source') },
        buildMakefile: receipt('makefile'),
        versionWord: 'B70 ',
        jsonFormatVersion: '2'
      },
      currentCompilerBound: true,
      gnuCompilerSource: source
    },
    cases: []
  };
  const expected = structuredClone(report);
  return { report: structuredClone(report), expected };
}
test('summary-only native envelopes are rejected before any evidence pathname is opened', () => {
  const { report, expected } = envelope();
  assert.throws(() => verifyDwarfQualification(report, expected), /Incomplete native DWARF matrix/);
});
for (const [name, mutate, pattern] of [
  [
    'partial smoke',
    (r) => {
      r.status = 'passed-partial';
    },
    /Full native DWARF/
  ],
  [
    'Clang consumer oracle',
    (r) => {
      r.kind = 'clang-dwarf-consumer-reference-only';
    },
    /gcc-wasi-native-dwarf/
  ],
  [
    'another source lock',
    (r) => {
      r.sourceLock.sha256 = 'b'.repeat(64);
    },
    /Stale DWARF sourceLock/
  ],
  [
    'another native compiler',
    (r) => {
      r.tools.gcc.sha256 = 'b'.repeat(64);
    },
    /Stale DWARF tools/
  ],
  [
    'another LLVM shared library',
    (r) => {
      r.analysisToolDependencies[0].sha256 = 'b'.repeat(64);
    },
    /LLVM dynamic dependencies/
  ],
  [
    'a relocated header root',
    (r) => {
      r.runtime.headers.gcc[0].path = '/other/header';
    },
    /runtime headers/
  ],
  [
    'an older GNU runtime',
    (r) => {
      r.runtime.currentCompilerBound = false;
    },
    /older compiler/
  ],
  [
    'another official gcov source',
    (r) => {
      r.runtime.coverageAnalysis.sources.gcov.sha256 = 'b'.repeat(64);
    },
    /coverage analysis sources/
  ],
  [
    'an omitted full-matrix profile',
    (r) => {
      r.scope.fullMatrix = false;
    },
    /fullMatrix/
  ],
  [
    'a widened debug profile',
    (r) => {
      r.profile.optimization = '2';
    },
    /qualified DWARF profile/
  ]
])
  test('the package gate rejects ' + name, () => {
    const { report, expected } = envelope();
    mutate(report);
    assert.throws(() => verifyDwarfQualification(report, expected), pattern);
  });

const realReport = process.env.GCC_WASI_DWARF_QUALIFICATION;
const realExpected = process.env.GCC_WASI_DWARF_EXPECTED;
const integration = { skip: !realReport || !realExpected };
async function real() {
  return {
    report: JSON.parse(await fs.readFile(realReport, 'utf8')),
    expected: JSON.parse(await fs.readFile(realExpected, 'utf8'))
  };
}
test(
  'the complete genuine native qualification reopens and passes the package gate',
  integration,
  async () => {
    const { report, expected } = await real();
    const result = await reopenDwarfQualification(report, expected);
    assert(
      result.programs >= 23 &&
        result.sourceUnits >= 45 &&
        result.liveFrames > 0 &&
        result.reopenedFiles > 100
    );
    if (process.env.GCC_WASI_DWARF_GATE_RESULT)
      await fs.writeFile(
        process.env.GCC_WASI_DWARF_GATE_RESULT,
        JSON.stringify({ status: 'passed', result }, null, 2) + '\n',
        { mode: 0o600, flag: 'wx' }
      );
  }
);

function replaceReceipt(value, oldPath, replacement) {
  if (typeof value === 'string') return value === oldPath ? replacement.path : value;
  if (!value || typeof value !== 'object') return value;
  if (value.path === oldPath && Object.hasOwn(value, 'bytes') && Object.hasOwn(value, 'sha256'))
    return replacement;
  if (Array.isArray(value)) return value.map((item) => replaceReceipt(item, oldPath, replacement));
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      typeof child === 'string' && child === oldPath
        ? replacement.path
        : replaceReceipt(child, oldPath, replacement)
    ])
  );
}
test(
  'a rehashed forged CDP snapshot cannot substitute a different actual code PC',
  integration,
  async () => {
    let { report, expected } = await real();
    const pause = report.cases[0].executions.find((run) => run.id === 'trap').pause;
    const snapshot = JSON.parse(await fs.readFile(pause.path, 'utf8'));
    snapshot.frames[0].pc += 1;
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dwarf-gate-cdp-'));
    try {
      const file = path.join(temporary, 'pause.json'),
        bytes = Buffer.from(JSON.stringify(snapshot));
      await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      report = replaceReceipt(report, pause.path, {
        path: file,
        ...dwarfIdentity(bytes)
      });
      await assert.rejects(
        () => reopenDwarfQualification(report, expected),
        /Paused CDP PC differs from original CODE base and raw location/
      );
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
);
test(
  'rehashed corrupt raw coverage cannot retain a successful stale official gcov JSON receipt',
  integration,
  async () => {
    let { report, expected } = await real();
    const execution = report.combinations.find((entry) => entry.id === 'debug-coverage').executions
      .node;
    const profile = execution.analysis[0].profile;
    const bytes = await fs.readFile(profile.path);
    bytes[0] ^= 0xff;
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dwarf-gate-gcda-'));
    try {
      const file = path.join(temporary, 'program.gcda');
      await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      report = replaceReceipt(report, profile.path, {
        path: file,
        ...dwarfIdentity(bytes)
      });
      const rawFile = path.join(temporary, 'raw-program.gcda');
      await fs.writeFile(rawFile, bytes, { mode: 0o600, flag: 'wx' });
      report = replaceReceipt(report, execution.profiles[0].path, {
        path: rawFile,
        ...dwarfIdentity(bytes)
      });
      await assert.rejects(
        () => reopenDwarfQualification(report, expected),
        /Official gcov-dump rejected combined raw coverage/
      );
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
);
