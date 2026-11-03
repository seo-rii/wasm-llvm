import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cases,
  controls,
  requiredCounts,
  registerBoundarySource,
  diagnostics,
  combinations,
  debugProfile
} from './dwarf-fixtures.mjs';

test('DWARF fixture contract covers real source and independent runtime expectations', () => {
  assert.equal(new Set(cases.map((value) => value.id)).size, cases.length);
  assert.deepEqual(
    {
      cases: cases.length,
      frameCases: cases.filter((value) => value.family === 'frames').length,
      wideCases: cases.filter((value) => value.family === 'wide').length,
      mainAbiCases: cases.filter((value) => value.family === 'main-abi').length,
      cppPreservationCases: cases.filter((value) => value.family === 'cpp-preservation').length,
      localBoundaryCases: cases.filter((value) => value.family === 'local-boundary').length,
      translationUnits: cases.reduce((total, value) => total + value.sources.length, 0),
      normalExecutionsPerHost: cases.reduce(
        (total, value) => total + value.runs.filter((run) => !run.trap).length,
        0
      ),
      trappedExecutionsPerHost: cases.reduce(
        (total, value) => total + value.runs.filter((run) => run.trap).length,
        0
      ),
      requiredLiveLocalIndices: cases.flatMap((value) => value.expected.actualLocalIndices ?? []),
      controlsPerFrameCase: controls.length
    },
    requiredCounts
  );
  for (const fixture of cases) {
    assert(fixture.sources.every((source) => fixture.files.some((file) => file.path === source)));
    assert(fixture.runs.some((run) => run.exitCode === 0));
    assert(fixture.files.every((file) => !/DW_OP_|__debugger|__wasm_debug/.test(file.contents)));
    if (fixture.runs.some((run) => run.trap))
      for (const name of fixture.expected.frames) {
        assert(fixture.sources.includes(fixture.expected.functionSources[name]));
        const file = fixture.files.find(
          (file) => file.path === fixture.expected.functionSources[name]
        );
        const lines = fixture.expected.sourceLines[name];
        assert(lines.length && lines.every((line) => Number.isSafeInteger(line) && line > 1));
        assert(lines.every((line) => line <= file.contents.split('\n').length));
        if (name === fixture.expected.frames[0])
          assert.equal(lines.length, 1, 'Leaf trap must have one independent exact source line');
      }
  }
});
test('multi-TU callers, duplicate static/source names and dead-code controls retain original semantics', () => {
  for (const fixture of cases.filter((value) => value.family === 'frames')) {
    assert.equal(fixture.sources.length, 3);
    assert.equal(
      fixture.sources.filter((source) =>
        source.endsWith('/' + fixture.expected.duplicateSourceBasename)
      ).length,
      2
    );
    assert.equal(
      fixture.files.filter((file) =>
        file.contents.includes('static __attribute__((noinline)) int same_name')
      ).length,
      3
    );
    assert.equal(fixture.expected.values.debug_leaf.local, 57);
    assert.equal(fixture.expected.values.debug_leaf.unused, 91);
    const leaf = fixture.files.find(
      (file) => file.path === fixture.expected.functionSources.debug_leaf
    ).contents;
    assert.match(leaf, /int debug_leaf\(int input, int trigger, int unused\)/);
    assert.equal(
      (leaf.match(/\bunused\b/g) ?? []).length,
      1,
      'The source parameter must stay unused so real location qualification covers the fallback'
    );
    assert.equal(fixture.expected.values.debug_middle.middle_local, 20);
    assert(fixture.files.some((file) => file.contents.includes('debug_dead')));
  }
});
test('local-boundary controls keep real register values live and never equate source ordinals with Wasm indices', () => {
  const boundaries = cases.filter((value) => value.family === 'local-boundary');
  assert.deepEqual(
    boundaries.map((value) => value.expected.actualLocalIndices),
    [
      [127, 128],
      [16383, 16384]
    ]
  );
  for (const fixture of boundaries) {
    const code = fixture.files[0].contents;
    assert(
      code.includes(
        `register int r${fixture.declarations - 1} = seed + ${fixture.declarations - 1};`
      )
    );
    assert(code.indexOf('if (trigger)') < code.indexOf('total += r0;'));
    assert(code.includes(`total += r${fixture.declarations - 1};`));
    assert(!/&r\d|\basm\b|__asm/.test(code));
  }
  assert.throws(() => registerBoundarySource(20001));
});
test('wide source expectations bind real two-i64 TI and binary128 pieces without substituting a runtime', () => {
  for (const fixture of cases.filter((value) => value.family === 'wide')) {
    assert.equal(fixture.expected.values.wide_leaf.whole.low, '0x99aabbccddeeff07');
    assert.equal(fixture.expected.values.wide_leaf.fraction.high, '0x3fff800000000000');
    assert.equal(fixture.expected.values.wide_leaf.local_fp.high, '0x4000400000000000');
    assert(
      fixture.files[0].contents.includes('__int128') &&
        fixture.files[0].contents.includes('long double')
    );
  }
});

import {
  llvmDwarfDies,
  dwarfFunction,
  inspectFunctionLocations,
  verifyPrologueLocationBoundary,
  inspectLlvmLocation,
  consumeDwarfPc
} from './dwarf-inspect.mjs';
// Synthetic LLVM-text reader contract only; never compiler/runtime qualification.
const bounded = `0x00000010:   DW_TAG_subprogram
                DW_AT_low_pc (0x00000010)
                DW_AT_high_pc (0x00000030)
                DW_AT_frame_base (0x00000000:
                  [0x00000020, 0x00000030): DW_OP_WASM_location 0x0 0x80, DW_OP_stack_value)
                DW_AT_name ("leaf")
0x00000020:     DW_TAG_variable
                  DW_AT_name ("wide")
                  DW_AT_location (DW_OP_WASM_location 0x0 0x7f, DW_OP_piece 0x8, DW_OP_WASM_location 0x0 0x80, DW_OP_piece 0x8)
0x00000025:     DW_TAG_variable
                  DW_AT_name ("unavailable")
0x00000029:     NULL
`;
test('official-text reader treats prologue and location-list endpoint as unavailable', () => {
  const die = dwarfFunction(llvmDwarfDies(bounded), 'leaf');
  assert.equal(inspectFunctionLocations(die, 0x1f).frameBase.kind, 'unavailable');
  assert.deepEqual(inspectFunctionLocations(die, 0x20).frameBase, {
    kind: 'local',
    index: 128,
    stackValue: true
  });
  assert.equal(inspectFunctionLocations(die, 0x30).frameBase.kind, 'unavailable');
  assert.equal(verifyPrologueLocationBoundary(die, 0x28).ready, 0x20);
});
test('wide actual-local pieces remain separate and unsupported physical registers are never invented', () => {
  const locations = inspectFunctionLocations(dwarfFunction(llvmDwarfDies(bounded), 'leaf'), 0x28);
  assert.deepEqual(locations.variables[0].location, {
    kind: 'pieces',
    indices: [127, 128],
    pieceBytes: [8, 8]
  });
  assert.equal(locations.variables[1].location.kind, 'unavailable');
  assert.throws(() => inspectLlvmLocation('DW_OP_reg3'), /Unsupported observed/);
  assert.throws(
    () => inspectLlvmLocation('DW_OP_WASM_location 0x0 0x3, DW_OP_stack_value'),
    /Unsupported observed/
  );
});

test('official-text source consumer rejects wrong statement lines, files and function names', () => {
  const program = {
    program: { path: '/original.wasm' },
    consumer: { path: '/consumer.wasm' },
    dies: llvmDwarfDies(bounded),
    files: [{ path: '/workspace/provider.c' }]
  };
  const fixture = {
    expected: { functionSources: { leaf: 'provider.c' }, sourceLines: { leaf: [7] } }
  };
  const source = { FunctionName: 'leaf', FileName: '/workspace/provider.c', Line: 7 };
  const toolPaths = { llvmDwarf: '/llvm-dwarfdump', symbolizer: '/llvm-symbolizer' };
  const run = (command, argv) => ({
    status: 0,
    signal: null,
    stderr: '',
    stdout:
      command === toolPaths.llvmDwarf
        ? bounded
        : JSON.stringify(
            argv.some((value) => value.startsWith('--obj='))
              ? [{ Symbol: [source] }]
              : { Frame: [] }
          )
  });
  const inspect = () =>
    consumeDwarfPc({ program, fixture, name: 'leaf', pc: 0x28, run, toolPaths, cwd: '/analysis' });
  assert.deepEqual(inspect().expectedSourceLines, [7]);
  source.Line = 1;
  assert.throws(inspect, /must match original leaf statement/);
  source.Line = 7;
  source.FileName = '/workspace/wrong.c';
  assert.throws(inspect, /exact source/);
  source.FileName = '/workspace/provider.c';
  source.FunctionName = 'other';
  assert.throws(inspect);
  source.FunctionName = 'leaf';
  program.sourcePaths = { 'provider.c': '/workspace/main.c' };
  source.FileName = '/workspace/main.c';
  assert.equal(inspect().source.FileName, '/workspace/main.c');
});

test('main ABI and constrained-mode controls cannot silently weaken to ordinary executions', () => {
  for (const fixture of cases.filter((value) => value.family === 'main-abi')) {
    assert(fixture.runs.some((value) => value.trap));
    assert.deepEqual(
      fixture.expected.values.main,
      fixture.abi === 'void'
        ? { trigger: 1 }
        : { argc: 3, argv: { type: 'argv-pointer', strings: ['program', 'trap', 'second'] } }
    );
  }
  assert.equal(diagnostics.length, 28);
  for (const language of ['c', 'cpp']) {
    const selected = diagnostics.filter((value) => value.language === language);
    assert.deepEqual(
      selected.slice(0, 4).map((value) => value.flags.at(-1)),
      ['-gdwarf-5', '-gdwarf64', '-gsplit-dwarf', '-dA']
    );
    for (const format of ['ctf', 'btf', 'codeview']) {
      assert.deepEqual(selected.find((value) => value.id === `${format}-${language}`).flags, [
        `-g${format}`
      ]);
      assert.deepEqual(
        selected.find((value) => value.id === `${format}-before-dwarf-${language}`).flags,
        [`-g${format}`, '-g']
      );
      assert.deepEqual(
        selected.find((value) => value.id === `${format}-after-dwarf-${language}`).flags,
        ['-g', `-g${format}`]
      );
    }
    assert.deepEqual(selected.at(-1).flags, ['-gctf', '-g0']);
  }
  assert.equal(cases.filter((value) => value.expected.templateConstructorDestructorRtti).length, 1);
});

test('debug combinations retain real coverage counters and SIMD source rather than metadata-only substitutes', () => {
  assert.deepEqual(debugProfile.compilerFlags, ['-g', '-gdwarf-4', '-gno-variable-location-views']);
  assert.deepEqual(
    combinations.map((value) => [value.id, value.feature]),
    [
      ['debug-coverage', 'coverage'],
      ['debug-simd', 'simd']
    ]
  );
  const coverage = combinations[0],
    simd = combinations[1];
  assert.equal(coverage.files[0].contents, coverage.coverageUnit.code);
  assert.deepEqual(coverage.coverageExpected.functions, { main: 1, classify: 6 });
  assert.deepEqual(coverage.coverageExpected.branches.classify, [
    [3, 3],
    [1, 2]
  ]);
  assert.equal(coverage.runs[0].stdout, '11\n');
  assert(simd.files[0].contents.includes('vector_size(16)'));
  assert(simd.files[0].contents.includes('vector4 sum = left + right'));
  assert.equal(simd.runs[0].stdout, 'simd 9 11 13 15\n');
  for (const fixture of combinations)
    assert(!/DW_OP_|__debugger|__wasm_debug/.test(fixture.files[0].contents));
});
