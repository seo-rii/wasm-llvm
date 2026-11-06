// Genuine GCC EH control-flow regressions. These sources require GNU C++ ABI
// providers; neither host exceptions nor a JavaScript exception simulation is
// accepted as a successful execution.
const io = `extern "C" int puts(const char *);
extern "C" int fflush(void *);
static int success(int value, int expected) {
  if (value != expected) return 91;
  puts("GCC-EH-PASS"); return 0;
}
`;
const termination = `extern "C" void _Exit(int) noexcept __attribute__((noreturn));
namespace std {
  using terminate_handler = void (*)();
  terminate_handler set_terminate(terminate_handler) noexcept;
}
static void terminated() {
  puts("GCC-EH-TERMINATE"); fflush(0); _Exit(67);
}
`;
const cases = [
  {
    name: 'ordered-filters', expected: { stdout: 'GCC-EH-PASS\n', exitCode: 0 },
    code: `${io}
__attribute__((noinline)) void raise_value(int v) { throw v; }
int main() {
  try { raise_value(47); }
  catch (double) { return 11; }
  catch (int value) { return success(value,47); }
  catch (...) { return 12; }
  return 13;
}
`,
  },
  {
    name: 'multitu-derived-rethrow', expected: { stdout: 'GCC-EH-PASS\n', exitCode: 0 },
    files: [{ path: 'types.h', contents: `struct Left { virtual ~Left() {} int left=5; };
struct Base { virtual ~Base() {} int value=37; };
struct Derived: Left, Base { int extra=9; };
void raise_derived();
` }, { path: 'throw.cpp', contents: `#include "types.h"
void raise_derived() { throw Derived{}; }
` }], sources: ['throw.cpp'],
    code: `${io}#include "types.h"
int main() {
  int seen=0;
  try { try { raise_derived(); } catch (Base &base) { seen=base.value; throw; } }
  catch (Derived &derived) { return success(seen+derived.extra+derived.left,51); }
  catch (...) { return 14; }
  return 15;
}
`,
  },
  {
    name: 'stack-cleanup', expected: { stdout: 'GCC-EH-PASS\n', exitCode: 0 },
    files: [{ path: 'throw.cpp', contents: `__attribute__((noinline)) void raise_stack() {
  volatile unsigned slots[257];
  for (unsigned i=0;i<257;++i) slots[i]=i+17;
  throw (int)slots[256];
}
` }], sources: ['throw.cpp'],
    code: `${io}
void raise_stack();
static int trace;
struct Guard { int mark; ~Guard() { trace=trace*10+mark; } };
__attribute__((noinline)) void middle() {
  volatile unsigned slots[193];
  for(unsigned i=0;i<193;++i) slots[i]=i+41;
  Guard one{1}; Guard two{2}; raise_stack();
  if (slots[192]!=233) trace=999;
}
int main() {
  volatile unsigned sentinel[127];
  for(unsigned i=0;i<127;++i) sentinel[i]=i+101;
  try { middle(); } catch(int value) {
    if(value!=273 || trace!=21) return 16;
    for(unsigned i=0;i<127;++i) if(sentinel[i]!=i+101) return 17;
    return success(trace,21);
  }
  return 18;
}
`,
  },
  {
    name: 'nested-reference', expected: { stdout: 'GCC-EH-PASS\n', exitCode: 0 },
    code: `${io}
static int trace;
__attribute__((noinline)) void raise_value(int value) { throw value; }
int main() {
  try {
    try { raise_value(73); }
    catch (int original) {
      if (original!=73) return 19;
      try { raise_value(29); } catch (int nested) { trace=nested; }
      throw;
    }
  } catch(int original) { return success(original+trace,102); }
  return 20;
}
`,
  },
  {
    name: 'cleanup-resume-reference', expected: { stdout: 'GCC-EH-PASS\n', exitCode: 0 },
    code: `${io}
static int trace;
struct Guard {
  ~Guard() {
    try { throw 19; } catch(int nested) { trace=trace*10+(nested==19?3:9); }
  }
};
__attribute__((noinline)) void propagate() {
  Guard guard;
  try { throw 61; } catch (...) { trace=2; throw; }
}
int main() {
  try { propagate(); } catch(int original) {
    if (original!=61) return 21;
    return success(trace,23);
  }
  return 22;
}
`,
  },
  {
    name: 'uncaught-terminate', expected: { stdout: 'GCC-EH-BEFORE\nGCC-EH-TERMINATE\n', exitCode: 67 },
    code: `${io}${termination}int main() { std::set_terminate(terminated); puts("GCC-EH-BEFORE"); fflush(0); throw 83; }
`,
  },
  {
    name: 'noexcept-terminate', expected: { stdout: 'GCC-EH-BEFORE\nGCC-EH-TERMINATE\n', exitCode: 67 },
    code: `${io}${termination}
__attribute__((noinline)) void raise_value() { throw 97; }
__attribute__((noinline)) void boundary() noexcept { raise_value(); }
int main() { std::set_terminate(terminated); puts("GCC-EH-BEFORE"); fflush(0); boundary(); return 23; }
`,
  },
];

export const nativeEhCases = Object.freeze(cases.flatMap(fixture => ['0','2'].map(optimization => ({
  id: `eh-native-${fixture.name}-o${optimization}`,
  kind: 'native-gnu-eh',
  request: { code: fixture.code, language: 'cpp', standard: 'c++17', optimization,
    exceptions: true, ...(fixture.files ? {files: fixture.files, sources: fixture.sources} : {}) },
  expected: fixture.expected,
}))));

export function assertNativeEhResult(fixture, result) {
  if (result.exitCode !== fixture.expected.exitCode || result.stdout !== fixture.expected.stdout)
    throw new Error(`${fixture.id}: expected GNU catch/cleanup result`);
}
