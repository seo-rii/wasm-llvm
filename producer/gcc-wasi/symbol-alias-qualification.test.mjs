import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { cases, diagnosticCases } from './symbol-alias-fixtures.mjs';
import { verifySymbolAliasQualification, verifySymbolAliasQualificationOptions } from './symbol-alias-qualification.mjs';

const identity = text => ({ bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
const receipt = name => ({ path: '/synthetic/' + name, ...identity(name) });

// Receipt-only unit fixtures. Actual native qualification separately compiles,
// executes, and reopens every Wasm object, executable and GNU archive member.
function metadata(fixture) {
  const symbols = fixture.aliasGroups.flatMap((group, index) => group.names.map(name => ({
    name, kind: group.kind, undefined: false, binding: 'global',
    visibility: fixture.visibility?.[name] || 'default',
    ...(group.kind === 'function' ? { entityIndex: index } : { segment: index, offset: 0, size: group.size || 4 })
  })));
  for (const name of fixture.localSymbols || []) symbols.push({ name, binding: 'local' });
  return { symbols, relocations: [] };
}

function proof() {
  const tools = Object.fromEntries(['gcc', 'gccCpp', 'clang', 'assembler', 'linker', 'archive', 'node'].map(name => [name, receipt(name)]));
  const recipes = Object.fromEntries(['test-symbol-alias.mjs', 'symbol-alias-fixtures.mjs', 'symbol-alias-inspect.mjs', 'wide-integer-test.mjs'].map(name => [name, receipt(name)]));
  const expected = { tools, recipes, sourceLock: receipt('source-lock'), nativeBuild: receipt('native-build'),
    gccSource: { gccCommit: 'synthetic', sourceDiffSha256: identity('source').sha256 },
    gnuRuntimeArchive: receipt('libsupc++.a'), programs: { cases: [] } };
  const report = { ...structuredClone(expected), kind: 'gcc-wasi-native-symbol-alias-qualification',
    status: 'passed', inputsUnchanged: true, counts: { programs: 106, diagnostics: 40, linkRejections: 32 },
    cases: [], diagnostics: [], negativeLinks: [], gnuRuntime: { archive: receipt('libsupc++.a'),
      metadata: metadata({ aliasGroups: cases.find(fixture => fixture.runtimeAliasGroups).runtimeAliasGroups }) } };
  for (const fixture of cases) for (const direction of ['gcc-gcc', 'gcc-clang', 'clang-gcc', 'clang-clang']
    .filter(value => fixture.interop || value === 'gcc-gcc' || value === 'clang-clang')
    .filter(value => fixture.clang !== false || !value.includes('clang'))) {
    const id = fixture.id + '-' + direction;
    const units = Array.from({ length: 1 + (fixture.request.sources?.length || 0) }, (_, index) => ({
      compiler: direction.split('-')[index === 0 ? 0 : 1], object: receipt(id + '-' + index + '.o')
    }));
    expected.programs.cases.push({ id, status: 'passed', stdout: fixture.stdout, units });
    report.cases.push({ id, fixture: fixture.id, direction, stdout: fixture.stdout,
      objects: units.map((unit, index) => ({ ...structuredClone(unit), metadata: index === 1 ? metadata(fixture) : metadata({ aliasGroups: [] }) })) });
  }
  function command(name, argv = [], status = 0, stderr = '') {
    return { command: tools[name].path, argv, status, signal: null, stdout: '', stderr };
  }
  function compile(request, family, status = 0, stderr = '') {
    return command(family === 'gcc' && request.language === 'cpp' ? 'gccCpp' : family, [
      '-O' + request.optimization, '-std=' + request.standard, '-mno-simd128', '-Werror=attributes',
      ...(family === 'clang' ? ['-c'] : []), ...(request.language === 'cpp' ? ['-fno-exceptions', '-fno-rtti'] : [])
    ], status, stderr);
  }
  for (const fixture of diagnosticCases) for (const family of fixture.clang === false ? ['gcc'] : ['gcc', 'clang'])
    report.diagnostics.push({ id: fixture.id, family, source: identity(fixture.request.code),
      command: compile(fixture.request, family, 1, fixture.diagnosticPattern.split('|')[0].replaceAll('.*', ' ')) });
  for (const kind of ['function', 'data']) for (const language of ['c', 'cpp'])
    for (const optimization of ['0', '2']) for (const family of ['gcc', 'clang']) {
      const id = `${kind}-${language}-o${optimization}-${family}`;
      const request = { language, optimization, standard: language === 'cpp' ? 'gnu++17' : 'gnu11' };
      const object = name => ({ object: receipt(id + '-' + name + '.o'), command: compile(request, family),
        ...(family === 'gcc' ? { assembler: command('assembler') } : {}) });
      const main = object('main'), providers = ['first', 'second'].map(name => ({ ...object(name),
        metadata: metadata({ aliasGroups: [{ kind, names: [name, 'shared_alias'] }] }) }));
      const paths = [main.object.path, ...providers.map(value => value.object.path)];
      report.negativeLinks.push({ id, main, providers,
        control: command('linker', ['--fatal-warnings', ...paths.slice(0, 2)]),
        duplicate: command('linker', ['--fatal-warnings', ...paths], 1, 'duplicate symbol: shared_alias'),
        undefined: command('linker', ['--fatal-warnings', paths[0]], 1, 'undefined symbol: shared_alias') });
    }
  return { expected, report };
}

function rejectMutations(mutations) {
  const { expected, report } = proof();
  verifySymbolAliasQualification(report, expected);
  for (const mutate of mutations) {
    const changed = structuredClone(report); mutate(changed);
    assert.throws(() => verifySymbolAliasQualification(changed, expected));
  }
}

test('patch 0017 requires alias proof, the real linker and GNU runtime', () => {
  const patches = [{ path: 'patches/0017-symbol-aliases.patch' }];
  const options = { symbolAliasQualification: '/proof', nativeLinker: '/linker', libstdcxx: '/runtime' };
  verifySymbolAliasQualificationOptions(patches, options);
  verifySymbolAliasQualificationOptions([], {});
  for (const name of Object.keys(options))
    assert.throws(() => verifySymbolAliasQualificationOptions(patches, { ...options, [name]: undefined }));
});

test('alias proof rejects stale sources, tools, recipes and GNU archives (synthetic receipts)', () => {
  rejectMutations([
    value => { value.inputsUnchanged = false; },
    ...['sourceLock', 'nativeBuild'].map(key => value => { value[key].sha256 = '0'.repeat(64); }),
    value => { value.gccSource.sourceDiffSha256 = '0'.repeat(64); },
    value => { value.tools.assembler.sha256 = '0'.repeat(64); },
    value => { delete value.recipes['symbol-alias-inspect.mjs']; },
    value => { value.gnuRuntime.archive.sha256 = '0'.repeat(64); }
  ]);
});

test('every mixed compiler direction must match the independently checked object proof (synthetic receipts)', () => {
  rejectMutations([
    value => { value.cases.pop(); },
    value => { value.cases[1] = structuredClone(value.cases[0]); },
    value => { value.cases[0].stdout = '0\n'; },
    value => { value.cases[0].objects[1].compiler = 'clang'; },
    value => { value.cases[0].objects[1].object.sha256 = '0'.repeat(64); },
    value => { value.cases[0].objects.pop(); }
  ]);
});

test('forwarding bodies and copied data cannot pass as aliases, including GNU __equal (synthetic receipts)', () => {
  rejectMutations([
    value => { value.cases[0].objects[1].metadata.symbols[1].entityIndex++; },
    value => { value.cases.find(entry => entry.fixture.includes('data-storage')).objects[1].metadata.symbols[1].offset++; },
    value => { value.cases[0].objects[1].metadata.symbols[1].binding = 'weak'; },
    value => { value.gnuRuntime.metadata.symbols[1].entityIndex++; }
  ]);
});

test('invalid aliases must fail real code generation with the expected diagnostic (synthetic receipts)', () => {
  rejectMutations([
    value => { value.diagnostics.pop(); },
    value => { value.diagnostics[0].source.sha256 = '0'.repeat(64); },
    value => { value.diagnostics[0].command.argv.push('-fsyntax-only'); },
    value => { value.diagnostics[0].command.argv.push('-O2'); },
    value => { value.diagnostics[0].command.status = 0; },
    value => { value.diagnostics[0].command.stderr = 'unrelated error'; },
    value => { value.diagnostics[0].object = receipt('unexpected.o'); }
  ]);
});

test('duplicate and undefined alias failures require the successful single-provider control (synthetic receipts)', () => {
  rejectMutations([
    value => { value.negativeLinks.pop(); },
    value => { value.negativeLinks[0].control.status = 1; },
    value => { value.negativeLinks[0].duplicate.status = 0; },
    value => { value.negativeLinks[0].duplicate.argv.pop(); },
    value => { value.negativeLinks[0].undefined.stderr = 'unrelated error'; },
    value => { value.negativeLinks[0].undefined.argv.push(value.negativeLinks[0].providers[0].object.path); },
    value => { value.negativeLinks[0].providers[0].metadata.symbols[1].entityIndex++; }
  ]);
});
