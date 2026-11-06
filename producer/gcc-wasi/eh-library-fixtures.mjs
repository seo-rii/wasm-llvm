// Additional contracts require the complete exception-enabled GNU library.
// They do not enlarge the small libsupc++ bootstrap's qualification claim.
const terminate = `#include <cstdio>
#include <cstdlib>
#include <exception>
static void terminate_handler() {
  std::puts("GNU-TERMINATE"); std::fflush(stdout); std::_Exit(67);
}
`;

const cases = [
  {
    name: 'vector-at', stdin: '5\n', stdout: 'vector range 1 unchanged 17\n',
    code: `#include <cstdio>
#include <vector>
#include <stdexcept>
int main() {
  unsigned index; if (std::scanf("%u", &index) != 1 || index != 5) return 1;
  std::vector<int> values{11,17,23}; unsigned caught = 0;
  try { values.at(index) = 99; }
  catch (std::out_of_range const& error) { caught = error.what()[0] != 0; }
  std::printf("vector range %u unchanged %d\\n", caught, values.at(1));
  return caught == 1 && values.at(1) == 17 ? 0 : 2;
}
`,
  },
  {
    name: 'runtime-error-ptr', stdout: 'runtime_error GNU payload retained\n',
    code: `#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <exception>
int main() {
  std::exception_ptr saved;
  try { throw std::runtime_error("GNU payload retained"); }
  catch (...) { saved = std::current_exception(); }
  try { std::rethrow_exception(saved); }
  catch (std::exception const& error) {
    std::printf("runtime_error %s\\n", error.what());
    return std::strcmp(error.what(), "GNU payload retained") == 0 ? 0 : 3;
  }
  return 4;
}
`,
  },
  {
    name: 'signed-int128', stdout: 'signed128 preserved\n',
    code: `#include <cstdio>
int main() {
  const __int128 original = -(((__int128)1 << 101) + 0x123456789abcdefLL);
  try { throw original; }
  catch (unsigned __int128) { return 5; }
  catch (__int128 value) {
    if (value != original) return 6;
    std::puts("signed128 preserved"); return 0;
  }
  return 7;
}
`,
  },
  {
    name: 'unsigned-int128', stdout: 'unsigned128 preserved\n',
    code: `#include <cstdio>
int main() {
  const unsigned __int128 original = ((unsigned __int128)1 << 127)
    | ((unsigned __int128)0x76543210 << 64) | 0xfedcba9876543210ULL;
  try { throw original; }
  catch (__int128) { return 8; }
  catch (unsigned __int128 value) {
    if (value != original) return 9;
    std::puts("unsigned128 preserved"); return 0;
  }
  return 10;
}
`,
  },
  {
    name: 'binary128-types', standard: 'gnu++17', stdout: 'long_double float128 exact distinct\n',
    code: `#include <cstdio>
#include <cstring>
static_assert(sizeof(long double) == 16 && sizeof(__float128) == 16, "binary128 ABI");
template<class T> bool exact(T value) {
  unsigned long long words[2]; std::memcpy(words, &value, sizeof value);
  return words[0] == 1 && words[1] == 0xc029000000000000ULL;
}
int main() {
  unsigned caught = 0;
  try { throw -0x1.0000000000000000000000000001p+42L; }
  catch (__float128) { return 11; }
  catch (long double value) { if (exact(value)) caught |= 1; }
  try { throw -0x1.0000000000000000000000000001p+42Q; }
  catch (long double) { return 12; }
  catch (__float128 value) { if (exact(value)) caught |= 2; }
  if (caught != 3) return 13;
  std::puts("long_double float128 exact distinct"); return 0;
}
`,
  },
  {
    name: 'main-argc-boundary', args: ['argument'],
    stdout: 'main argc 2 argument\nGNU-TERMINATE\n', exitCode: 67,
    code: `${terminate}int main(int argc, char** argv) {
  std::set_terminate(terminate_handler);
  std::printf("main argc %d %s\\n", argc, argc == 2 ? argv[1] : "missing");
  std::fflush(stdout); throw 14;
}
`,
  },
  {
    name: 'global-constructor-boundary', stdout: 'global ctor\nGNU-TERMINATE\n', exitCode: 67,
    code: `${terminate}struct Object {
  Object() {
    std::set_terminate(terminate_handler);
    std::puts("global ctor"); std::fflush(stdout); throw 15;
  }
} object;
int main() { std::puts("unexpected main"); return 16; }
`,
  },
  ...['return','exit'].map(mode => ({
    name: `global-destructor-${mode}-boundary`,
    stdout: `main ${mode}\nglobal dtor\nGNU-TERMINATE\n`, exitCode: 67,
    code: `${terminate}struct Object {
  ~Object() noexcept(false) { std::puts("global dtor"); std::fflush(stdout); throw 17; }
} object;
int main() {
  std::set_terminate(terminate_handler);
  std::puts("main ${mode}"); std::fflush(stdout);
  ${mode === 'return' ? 'return 0;' : 'std::exit(0);'}
}
`,
  })),
];

export const exceptionLibraryCases = Object.freeze(cases.flatMap(fixture => ['0','2'].map(optimization => ({
  id: `eh-library-${fixture.name}-o${optimization}`,
  kind: 'gnu-exception-library',
  request: { language: 'cpp', standard: fixture.standard ?? 'c++17', optimization, exceptions: true, rtti: false, code: fixture.code },
  run: { stdin: fixture.stdin ?? '', args: fixture.args ?? [] },
  stdout: fixture.stdout, stderr: '', exitCode: fixture.exitCode ?? 0,
}))));
