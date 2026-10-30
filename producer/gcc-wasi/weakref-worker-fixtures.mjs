import { units, cases as nativeCases } from './weakref-fixtures.mjs';

const byId = new Map(units.map(unit => [unit.id, unit]));

// The public SDK compiles every translation unit with GCC. Mixed GCC/Clang
// objects and rejected links are checked separately with the same Wasm tools.
export const cases = nativeCases
  .filter(fixture => !fixture.expectedLinkRejection && fixture.units.every(id => byId.get(id).compiler === 'gcc'))
  .map(fixture => {
    const [main, ...providers] = fixture.units.map(id => byId.get(id));
    const files = providers.map((unit, index) => ({
      path: `provider${index}.${unit.language === 'cpp' ? 'cc' : 'c'}`,
      contents: unit.code
    }));
    return {
      id: fixture.id.replaceAll(':', '-'),
      request: {
        language: main.language,
        standard: main.language === 'cpp' ? 'gnu++17' : 'gnu11',
        optimization: String(main.optimization),
        emit: 'executable',
        simd: false,
        code: main.code,
        ...(files.length ? { files, sources: files.map(file => file.path) } : {})
      },
      stdin: fixture.stdin,
      stdout: fixture.stdout,
      weakref: { nativeCase: fixture.id, units: fixture.units, runtime: fixture.runtime }
    };
  });
