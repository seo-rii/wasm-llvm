// Original programs shared by native and eventual Wasm-host qualification.
// Expected values describe source semantics; emitted Wasm local indices are measured.
import { units as coverageUnits, cases as coverageCases } from './coverage-fixtures.mjs';

export const debugProfile = Object.freeze({
  format: 'DWARF32',
  version: 4,
  optimization: '0',
  embedded: true,
  compilerFlags: Object.freeze(['-g', '-gdwarf-4', '-gno-variable-location-views']),
  generalExpressionEvaluator: false,
  optimizedRegisterLocations: false
});
const recordHeader = (language) =>
  language === 'c'
    ? `#ifndef FRAME_RECORD_H
#define FRAME_RECORD_H
#include <stddef.h>
typedef struct FrameRecord { int tag; long long wide; double ratio; } FrameRecord;
_Static_assert(sizeof(FrameRecord) == 24 && offsetof(FrameRecord, wide) == 8 && offsetof(FrameRecord, ratio) == 16, "frame layout");
int debug_middle(int input, int trigger);
#endif
`
    : `#ifndef FRAME_RECORD_H
#define FRAME_RECORD_H
#include <stddef.h>
class FrameRecord { public: int tag; long long wide; double ratio; };
static_assert(sizeof(FrameRecord) == 24 && offsetof(FrameRecord, wide) == 8 && offsetof(FrameRecord, ratio) == 16, "frame layout");
int debug_middle(int input, int trigger);
#endif
`;
const mainSource = `#include <stdio.h>
#include "record.h"
static __attribute__((noinline)) int same_name(int value) { register int local = value + 1; return local; }
int main(void) {
  int value = 0, trigger = 0;
  if (scanf("%d %d", &value, &trigger) != 2) return 2;
  printf("layout %zu %zu %zu %zu\\n", sizeof(FrameRecord), offsetof(FrameRecord, tag), offsetof(FrameRecord, wide), offsetof(FrameRecord, ratio));
  fflush(stdout);
  int result = debug_middle(same_name(value), trigger);
  printf("result %d\\n", result);
  return 0;
}
`;
const middleSource = `#include "record.h"
int debug_leaf(int input, int trigger);
static __attribute__((noinline)) int same_name(int value) { register int local = value + 2; return local; }
__attribute__((noinline)) int debug_middle(int input, int trigger) {
  register int middle_local = same_name(input) * 2;
  return debug_leaf(middle_local + 3, trigger) + 5;
}
`;
const leafSource = `#include "record.h"
static __attribute__((noinline)) int same_name(int value) { register int local = value + 3; return local; }
__attribute__((noinline)) int debug_leaf(int input, int trigger) {
  register int adjusted = input + 11;
  FrameRecord record = { same_name(input) - 3, 0x1122334455667788LL, 3.5 };
  register int local = adjusted + record.tag;
  if (trigger) __builtin_trap();
  return local;
}
__attribute__((noinline)) int debug_dead(int value) { return value + 999; }
`;
const wideSource = `#include <stdio.h>
__attribute__((noinline)) int wide_leaf(unsigned __int128 whole, long double fraction, int trigger) {
  register unsigned __int128 local_wide = whole ^ ((unsigned __int128)1 << 64);
  register long double local_fp = fraction + 1.0L;
  if (trigger) __builtin_trap();
  printf("wide %llx %llx %d\\n", (unsigned long long)(local_wide >> 64), (unsigned long long)local_wide, local_fp == 2.5L);
  return 0;
}
int main(void) {
  unsigned long long seed = 0; int trigger = 0;
  if (scanf("%llu %d", &seed, &trigger) != 2) return 2;
  unsigned __int128 whole = ((unsigned __int128)0x1122334455667788ULL << 64) | (0x99aabbccddeeff00ULL + seed);
  return wide_leaf(whole, 1.5L, trigger);
}
`;
export function registerBoundarySource(declarations) {
  if (!Number.isSafeInteger(declarations) || declarations < 2 || declarations > 20000)
    throw new Error('Invalid bounded register fixture size');
  return `#include <stdio.h>
__attribute__((noinline)) int boundary_leaf(int seed, int trigger) {
${Array.from({ length: declarations }, (_, index) => `  register int r${index} = seed + ${index};`).join('\n')}
  if (trigger) __builtin_trap();
  register int total = 0;
${Array.from({ length: declarations }, (_, index) => `  total += r${index};`).join('\n')}
  return total;
}
int main(void) {
  int seed = 0, trigger = 0;
  if (scanf("%d %d", &seed, &trigger) != 2) return 2;
  printf("boundary %d\\n", boundary_leaf(seed, trigger));
  return 0;
}
`;
}
export const cases = [];
for (const language of ['c', 'cpp']) {
  const extension = language === 'c' ? 'c' : 'cpp';
  cases.push({
    id: `frames-${language}`,
    family: 'frames',
    language,
    standard: language === 'c' ? 'gnu11' : 'gnu++17',
    files: [
      { path: 'record.h', contents: recordHeader(language) },
      { path: `main.${extension}`, contents: mainSource },
      { path: `left/provider.${extension}`, contents: middleSource },
      { path: `right/provider.${extension}`, contents: leafSource }
    ],
    sources: [`main.${extension}`, `left/provider.${extension}`, `right/provider.${extension}`],
    runs: [
      { id: 'normal', stdin: '7 0\n', stdout: 'layout 24 0 8 16\nresult 62\n', exitCode: 0 },
      { id: 'trap', stdin: '7 1\n', stdout: 'layout 24 0 8 16\n', trap: true }
    ],
    expected: {
      frames: ['debug_leaf', 'debug_middle', 'main'],
      functionSources: {
        debug_leaf: `right/provider.${extension}`,
        debug_middle: `left/provider.${extension}`,
        main: `main.${extension}`
      },
      trapSource: `right/provider.${extension}`,
      values: {
        debug_leaf: {
          input: 23,
          trigger: 1,
          adjusted: 34,
          local: 57,
          record: {
            size: 24,
            members: {
              tag: { offset: 0, type: 'i32', value: 23 },
              wide: { offset: 8, type: 'u64', value: '0x1122334455667788' },
              ratio: { offset: 16, type: 'f64', value: 3.5 }
            }
          }
        },
        debug_middle: { input: 8, trigger: 1, middle_local: 20 },
        main: { value: 7, trigger: 1 }
      },
      duplicateStaticName: 'same_name',
      duplicateSourceBasename: `provider.${extension}`,
      deadFunction: 'debug_dead',
      recordType: 'FrameRecord'
    }
  });
  cases.push({
    id: `wide-${language}`,
    family: 'wide',
    language,
    standard: language === 'c' ? 'gnu11' : 'gnu++17',
    files: [{ path: `wide.${extension}`, contents: wideSource }],
    sources: [`wide.${extension}`],
    runs: [
      {
        id: 'normal',
        stdin: '7 0\n',
        stdout: 'wide 1122334455667789 99aabbccddeeff07 1\n',
        exitCode: 0
      },
      { id: 'trap', stdin: '7 1\n', stdout: '', trap: true }
    ],
    expected: {
      frames: ['wide_leaf', 'main'],
      functionSources: { wide_leaf: `wide.${extension}`, main: `wide.${extension}` },
      trapSource: `wide.${extension}`,
      values: {
        wide_leaf: {
          whole: { type: 'u128-pieces', low: '0x99aabbccddeeff07', high: '0x1122334455667788' },
          fraction: { type: 'f128-pieces', low: '0x0', high: '0x3fff800000000000' },
          local_wide: {
            type: 'u128-pieces',
            low: '0x99aabbccddeeff07',
            high: '0x1122334455667789'
          },
          local_fp: { type: 'f128-pieces', low: '0x0', high: '0x4000400000000000' }
        }
      }
    }
  });
  for (const abi of ['void', 'argc-argv']) {
    const code =
      abi === 'void'
        ? '#include <stdio.h>\nint main(void) { int trigger = 0; if (scanf("%d", &trigger) != 1) return 2; puts("main void 17"); fflush(stdout); if (trigger) __builtin_trap(); return 0; }\n'
        : '#include <stdio.h>\nint main(int argc, char **argv) { printf("main args %d %s %s\\n", argc, argv[1], argv[2]); fflush(stdout); if (argv[1][0] == \'t\') __builtin_trap(); return argc == 3 ? 0 : 3; }\n';
    cases.push({
      id: `main-${abi}-${language}`,
      family: 'main-abi',
      abi,
      language,
      standard: language === 'c' ? 'gnu11' : 'gnu++17',
      files: [{ path: `main.${extension}`, contents: code }],
      sources: [`main.${extension}`],
      runs: [
        {
          id: 'normal',
          stdin: abi === 'void' ? '0\n' : '',
          args: abi === 'void' ? [] : ['first', 'second'],
          stdout: abi === 'void' ? 'main void 17\n' : 'main args 3 first second\n',
          exitCode: 0
        },
        {
          id: 'trap',
          stdin: abi === 'void' ? '1\n' : '',
          args: abi === 'void' ? [] : ['trap', 'second'],
          stdout: abi === 'void' ? 'main void 17\n' : 'main args 3 trap second\n',
          trap: true
        }
      ],
      expected: {
        frames: ['main'],
        functionSources: { main: `main.${extension}` },
        values: {
          main:
            abi === 'void'
              ? { trigger: 1 }
              : { argc: 3, argv: { type: 'argv-pointer', strings: ['program', 'trap', 'second'] } }
        }
      }
    });
  }
}
for (const [id, declarations, indices] of [
  ['uleb7', 160, [127, 128]],
  ['uleb14', 16420, [16383, 16384]]
]) {
  const sum = declarations * 7 + (declarations * (declarations - 1)) / 2;
  cases.push({
    id: `locals-${id}`,
    family: 'local-boundary',
    language: 'c',
    standard: 'gnu11',
    files: [{ path: 'boundary.c', contents: registerBoundarySource(declarations) }],
    sources: ['boundary.c'],
    declarations,
    runs: [
      { id: 'normal', stdin: '7 0\n', stdout: `boundary ${sum}\n`, exitCode: 0 },
      { id: 'trap', stdin: '7 1\n', stdout: '', trap: true }
    ],
    expected: {
      frames: ['boundary_leaf', 'main'],
      functionSources: { boundary_leaf: 'boundary.c', main: 'boundary.c' },
      trapSource: 'boundary.c',
      actualLocalIndices: indices,
      registerSourcePrefix: 'r',
      seed: 7
    }
  });
}
cases.push({
  id: 'cpp-feature-preservation',
  family: 'cpp-preservation',
  language: 'cpp',
  standard: 'gnu++17',
  files: [
    {
      path: 'main.cpp',
      contents: `#include <stdio.h>
#include <typeinfo>
template<class T> __attribute__((noinline)) T plus_four(T value) { return value + 4; }
class Base { public: virtual ~Base() {} virtual int value() const = 0; };
class Derived : public Base { int number; public:
  explicit Derived(int input) : number(input) { printf("ctor %d\\n", number); }
  ~Derived() { printf("dtor %d\\n", number); }
  int value() const { return plus_four(number); }
};
int main(void) {
  int input = 0; if (scanf("%d", &input) != 1) return 2;
  { Derived object(input); Base *base = &object; Derived *derived = dynamic_cast<Derived *>(base);
    printf("cpp %d %d\\n", derived ? derived->value() : -1, typeid(*base) == typeid(Derived)); }
  return 0;
}
`
    }
  ],
  sources: ['main.cpp'],
  runs: [{ id: 'normal', stdin: '7\n', stdout: 'ctor 7\ncpp 11 1\ndtor 7\n', exitCode: 0 }],
  expected: { frames: ['main'], templateConstructorDestructorRtti: true }
});

// These line oracles come from the original statements, independently of any
// emitted line table. A suspended caller can report the call instruction or its
// return address on the following source line; a trap must report its own line.
for (const fixture of cases.filter((value) => value.runs.some((run) => run.trap))) {
  const extension = fixture.language === 'cpp' ? 'cpp' : 'c';
  const statementLines = (source, statement, caller = false) => {
    const file = fixture.files.find((file) => file.path === source);
    const lines = file.contents.split('\n');
    const matches = lines.flatMap((line, index) => (line.includes(statement) ? [index + 1] : []));
    if (matches.length !== 1) throw new Error('Ambiguous independent source-line oracle');
    return caller ? [matches[0], Math.min(matches[0] + 1, lines.length)] : matches;
  };
  if (fixture.family === 'frames')
    fixture.expected.sourceLines = {
      debug_leaf: statementLines(`right/provider.${extension}`, 'if (trigger) __builtin_trap();'),
      debug_middle: statementLines(`left/provider.${extension}`, 'return debug_leaf(', true),
      main: statementLines(`main.${extension}`, 'int result = debug_middle(', true)
    };
  else if (fixture.family === 'wide')
    fixture.expected.sourceLines = {
      wide_leaf: statementLines(`wide.${extension}`, 'if (trigger) __builtin_trap();'),
      main: statementLines(`wide.${extension}`, 'return wide_leaf(', true)
    };
  else if (fixture.family === 'main-abi')
    fixture.expected.sourceLines = {
      main: statementLines(`main.${extension}`, '__builtin_trap()')
    };
  else if (fixture.family === 'local-boundary')
    fixture.expected.sourceLines = {
      boundary_leaf: statementLines('boundary.c', 'if (trigger) __builtin_trap();'),
      main: statementLines('boundary.c', 'printf("boundary ', true)
    };
  else throw new Error('Missing independent source-line oracle family');
}
export const controls = Object.freeze([
  { id: 'default-release', kind: 'release', optimization: '0', debug: 'default' },
  { id: 'explicit-g0', kind: 'release', optimization: '0', debug: 'g0' },
  { id: 'default-release-o2', kind: 'release', optimization: '2', debug: 'default' },
  { id: 'explicit-g0-o2', kind: 'release', optimization: '2', debug: 'g0' },
  { id: 'optimized-unavailable', kind: 'optimized', optimization: '2', debug: 'dwarf4' },
  { id: 'strip-debug', kind: 'strip', option: '--strip-debug' },
  { id: 'strip-all', kind: 'strip', option: '--strip-all' }
]);
export const diagnostics = ['c', 'cpp'].flatMap((language) =>
  [
    ['dwarf5', ['-g', '-gdwarf-5']],
    ['dwarf64', ['-g', '-gdwarf-4', '-gdwarf64']],
    ['split', ['-g', '-gdwarf-4', '-gsplit-dwarf']],
    ['debug-assembly', ['-g', '-gdwarf-4', '-dA']],
    ...['ctf', 'btf', 'codeview'].flatMap((format) => [
      [format, [`-g${format}`]],
      [`${format}-before-dwarf`, [`-g${format}`, '-g']],
      [`${format}-after-dwarf`, ['-g', `-g${format}`]]
    ]),
    ['ctf-survives-g0', ['-gctf', '-g0']]
  ].map(([name, flags]) => ({
    id: `${name}-${language}`,
    language,
    flags,
    code: 'int main(void) { return 0; }\n'
  }))
);
export const requiredCounts = Object.freeze({
  cases: 11,
  frameCases: 2,
  wideCases: 2,
  mainAbiCases: 4,
  cppPreservationCases: 1,
  localBoundaryCases: 2,
  translationUnits: 15,
  normalExecutionsPerHost: 11,
  trappedExecutionsPerHost: 10,
  requiredLiveLocalIndices: [127, 128, 16383, 16384],
  controlsPerFrameCase: 7
});

const coverageCase = coverageCases.find((fixture) => fixture.id === 'core-c-o0-coverage');
const coverageUnit = coverageUnits.find((unit) => unit.id === coverageCase.units[0]);
export const combinations = Object.freeze([
  {
    id: 'debug-coverage',
    family: 'combination',
    feature: 'coverage',
    language: 'c',
    standard: coverageUnit.standard,
    files: [{ path: 'combined.c', contents: coverageUnit.code }],
    sources: ['combined.c'],
    runs: [{ id: 'normal', stdin: coverageCase.stdin, stdout: coverageCase.stdout, exitCode: 0 }],
    coverageUnit,
    coverageExpected: coverageCase.expected[0]
  },
  {
    id: 'debug-simd',
    family: 'combination',
    feature: 'simd',
    language: 'c',
    standard: 'gnu11',
    files: [
      {
        path: 'combined.c',
        contents: `#include <stdio.h>
typedef int vector4 __attribute__((vector_size(16)));
__attribute__((noinline)) int simd_leaf(int seed) {
  vector4 left = { seed, seed + 1, seed + 2, seed + 3 };
  vector4 right = { 2, 3, 4, 5 };
  vector4 sum = left + right;
  printf("simd %d %d %d %d\\n", sum[0], sum[1], sum[2], sum[3]);
  return 0;
}
int main(void) { int seed = 0; if (scanf("%d", &seed) != 1) return 2; return simd_leaf(seed); }
`
      }
    ],
    sources: ['combined.c'],
    runs: [{ id: 'normal', stdin: '7\n', stdout: 'simd 9 11 13 15\n', exitCode: 0 }]
  }
]);
