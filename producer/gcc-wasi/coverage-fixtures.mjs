// Shared original sources and independent expected counts for native/Worker runs.
const headers = '#include <stdio.h>\n#include <stdlib.h>\n';
const begin = '#ifdef __cplusplus\nextern "C" {\n#endif\n';
const end = '#ifdef __cplusplus\n}\n#endif\n';
const classify = `__attribute__((noinline)) int classify(int value) {
  if (value < 0) return -value;
  if (value & 1) return value * 3 + 1;
  return value / 2;
}
`;
const main = `int main(void) {
  int count;
  if (scanf("%d", &count) != 1 || count != 6) return 2;
  int sum = 0;
  for (int index = -3; index < count - 3; ++index) sum += classify(index);
  printf("%d\\n", sum);
  return 0;
}
`;
const core = headers + begin + classify + main + end;
const cExit = headers + begin + classify
  + 'static void user_exit(void) { printf("exit %d\\n", classify(-7)); }\n'
  + main.replace('int main(void) {', 'int main(void) {\n  if (atexit(user_exit)) return 3;') + end;
const cppExit = core + `class Tail {
public:
  __attribute__((noinline)) ~Tail() { printf("exit %d\\n", classify(-7)); }
};
static Tail tail;
`;
export const units = [], cases = [];
for (const language of ['c', 'cpp']) for (const optimization of ['0', '2']) {
  for (const mode of ['coverage', 'normal']) for (const scenario of ['core', 'exit', 'multiple', 'driver']) {
    // The driver control is another real entry point to the same coverage
    // contract, not an additional copy of the ordinary source controls.
    if (scenario === 'driver' && mode === 'normal') continue;
    const id = `${scenario}-${language}-o${optimization}-${mode}`;
    const code = scenario === 'exit' ? (language === 'c' ? cExit : cppExit)
      : scenario === 'multiple' ? headers + begin + 'int classify(int);\n' + main + end : core;
    const names = [`${id}-main`];
    const definitions = [{ id: names[0], code, gcovStem: 'program' }];
    if (scenario === 'multiple') {
      names.push(`${id}-provider`);
      definitions.push({ id: names[1], code: begin + classify + end, gcovStem: 'program.1' });
    }
    for (const definition of definitions) units.push({ ...definition, language, optimization, mode,
      standard: language === 'c' ? 'gnu11' : 'gnu++17', driver: scenario === 'driver' });
    const extra = scenario === 'exit';
    const counts = { main: 1, classify: extra ? 7 : 6,
      ...(extra ? { [language === 'c' ? 'user_exit' : '_ZN4TailD1Ev']: 1 } : {}) };
    const expected = definitions.map((definition, index) => ({ unit: definition.id,
      functions: scenario === 'multiple' ? (index ? { classify: 6 } : { main: 1 }) : counts,
      branches: scenario === 'multiple' && !index ? {} : { classify: [[extra ? 4 : 3, 3], [1, 2]] } }));
    const extension = language === 'c' ? 'c' : 'cpp';
    cases.push({ id, units: names, mode, scenario, language, optimization, stdin: '6\n',
      stdout: extra ? '11\nexit 7\n' : '11\n', expected,
      runs: mode === 'coverage' && scenario === 'core' ? 2 : 1,
      request: { language, standard: language === 'c' ? 'gnu11' : 'gnu++17', optimization,
        emit: 'executable', coverage: mode === 'coverage', code,
        ...(scenario === 'multiple' ? { files: [{ path: `provider.${extension}`, contents: definitions[1].code }],
          sources: [`provider.${extension}`] } : {}) } });
  }
}
// Distinguish data without notes and notes without data. These controls are
// compiled and inspected, never substituted for the combined coverage proof.
export const metadataControls = ['c', 'cpp'].flatMap(language => ['0', '2'].flatMap(optimization =>
  ['notes', 'arcs'].map(mode => ({ id: `${mode}-${language}-o${optimization}`, language, optimization,
    standard: language === 'c' ? 'gnu11' : 'gnu++17', mode, driver: false,
    code: core, gcovStem: 'program' }))));

const unsupported = [
  ['profile', ['-fprofile']], ['p', ['-p']], ['pg', ['-pg'], true],
  ['generate', ['-fprofile-generate']], ['generate-path', ['-fprofile-generate=/profile']],
  ['generate-bypass', ['-fprofile-generate', '-fno-profile-values']],
  ['use', ['-fprofile-use']], ['use-path', ['-fprofile-use=/profile']],
  ['values', ['-fprofile-values']], ['branch-probabilities', ['-fbranch-probabilities']],
  ['auto-profile', ['-fauto-profile']], ['auto-profile-path', ['-fauto-profile=fbdata.afdo']],
  ['atomic', ['-fprofile-arcs', '-ftest-coverage', '-fprofile-update=atomic']],
  ['prefer-atomic', ['-fprofile-arcs', '-ftest-coverage', '-fprofile-update=prefer-atomic']],
  ['info-section', ['-fprofile-arcs', '-ftest-coverage', '-fprofile-info-section']],
  ['info-section-name', ['-fprofile-arcs', '-ftest-coverage', '-fprofile-info-section=.gcov_info']],
  ['conditions', ['-fcondition-coverage']], ['paths', ['-fpath-coverage']],
  ['instrument-functions', ['-finstrument-functions']], ['instrument-functions-once', ['-finstrument-functions-once']],
  ['filter', ['-fprofile-filter-files=.*']], ['exclude', ['-fprofile-exclude-files=.*']],
  ['reproducible', ['-fprofile-reproducible=serial']], ['pid-path', ['-fprofile-dir=/profile/%p']],
  ['environment-path', ['-fprofile-dir=/profile/%q{NAME}']],
  ['correction', ['-fprofile-correction']], ['partial-training', ['-fprofile-partial-training']],
  ['report', ['-fprofile-report']], ['reorder-functions', ['-fprofile-reorder-functions']],
  ['prefix-map', ['-fprofile-prefix-map=/old=/new']],
];
export const diagnostics = ['c', 'cpp'].flatMap(language => ['0', '2'].flatMap(optimization =>
  unsupported.map(([name, flags, driver = false]) => ({ id: `${name}-${language}-o${optimization}`,
    language, optimization, flags, driver, code: 'int main(void) { return 0; }\n',
    diagnostic: 'GCC wasm32-wasi does not support profiling option' }))));
export const requiredCounts = Object.freeze({ units: 36, cases: 28, coverage: 16, controls: 12,
  nativeExecutions: 32, profileExecutions: 20, metadataControls: 8, diagnostics: 120 });
export const wasiRunnerSource = `import { WASI } from 'node:wasi';
import { readFile } from 'node:fs/promises';
const wasi = new WASI({version:'preview1',args:['program'],env:{},preopens:{'/profile':process.argv[3]},returnOnExit:true});
process.exitCode = wasi.start(await WebAssembly.instantiate(await WebAssembly.compile(await readFile(process.argv[2])),{wasi_snapshot_preview1:wasi.wasiImport}));
`;
