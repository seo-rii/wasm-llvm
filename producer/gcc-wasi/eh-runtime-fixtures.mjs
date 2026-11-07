// Real GNU allocation, RTTI, catch, rethrow and cleanup contracts.
// The first matrix uses libsupc++ plus the native Wasm unwinder; the full
// exception-enabled libstdc++ variant has additional standard-library gates.
const definitions = [
  {
    name: 'typed-cleanup', rtti: false, stdout: 'typed 42 trace 123\n',
    code: `#include <cstdio>
static unsigned trace;
struct Guard { unsigned id; ~Guard() { trace = trace * 10 + id; } };
__attribute__((noinline)) void raise_value() { Guard inner{1}; throw 42; }
int main() {
  int value = 0;
  try { Guard outer{2}; raise_value(); }
  catch (int caught) { value = caught; trace = trace * 10 + 3; }
  std::printf("typed %d trace %u\\n", value, trace);
  return value == 42 && trace == 123 ? 0 : 1;
}
`,
  },
  {
    name: 'base-adjustment', rtti: false,
    stdout: 'base 37 adjusted 1 destroyed 1\n',
    code: `#include <cstdio>
#include <cstdint>
static std::uintptr_t complete_address, base_address;
static unsigned destroyed;
struct Left { int left = 11; virtual ~Left() {} };
struct Base { int value = 37; virtual ~Base() {} };
struct Derived : Left, Base {
  Derived() { complete_address = reinterpret_cast<std::uintptr_t>(this);
    base_address = reinterpret_cast<std::uintptr_t>(static_cast<Base*>(this)); }
  ~Derived() { ++destroyed; }
};
int main() {
  int value = 0; unsigned adjusted = 0;
  try { throw Derived(); }
  catch (Base const& object) {
    value = object.value;
    adjusted = reinterpret_cast<std::uintptr_t>(&object) == base_address
      && base_address > complete_address;
  }
  std::printf("base %d adjusted %u destroyed %u\\n", value, adjusted, destroyed);
  return value == 37 && adjusted == 1 && destroyed == 1 ? 0 : 2;
}
`,
  },
  {
    name: 'nested-rethrow', rtti: false,
    stdout: 'rethrow 9 caught 0 unwinding 1 final 0\n',
    code: `#include <cstdio>
#include <exception>
static int unwinding;
struct Guard { ~Guard() { unwinding = std::uncaught_exceptions(); } };
int main() {
  int value = 0, inside = -1;
  try { Guard guard; try { throw 7; }
    catch (int& object) { inside = std::uncaught_exceptions(); object = 9; throw; }
  } catch (int caught) { value = caught; }
  int final = std::uncaught_exceptions();
  std::printf("rethrow %d caught %d unwinding %d final %d\\n", value, inside, unwinding, final);
  return value == 9 && inside == 0 && unwinding == 1 && final == 0 ? 0 : 3;
}
`,
  },
  {
    name: 'exception-ptr', rtti: false,
    stdout: 'exception_ptr 31 retained 0 destroyed 1 final 0\n',
    code: `#include <cstdio>
#include <exception>
static unsigned destroyed;
struct Item { int value; explicit Item(int n) : value(n) {} ~Item() { ++destroyed; } };
int main() {
  std::exception_ptr saved; int value = 0;
  try { throw Item(31); } catch (...) { saved = std::current_exception(); }
  unsigned retained = destroyed;
  try { std::rethrow_exception(saved); } catch (Item const& item) { value = item.value; }
  saved = nullptr;
  int final = std::uncaught_exceptions();
  std::printf("exception_ptr %d retained %u destroyed %u final %d\\n", value, retained, destroyed, final);
  return value == 31 && retained == 0 && destroyed == 1 && final == 0 ? 0 : 4;
}
`,
  },
  {
    name: 'allocation-loop', rtti: false, stdin: '128 17\n',
    stdout: 'loop 10304 destroyed 128 final 0\n',
    code: `#include <cstdio>
#include <exception>
static unsigned destroyed;
struct Item { int value; explicit Item(int n) : value(n) {} ~Item() { ++destroyed; } };
int main() {
  int count, start, sum = 0;
  if (std::scanf("%d %d", &count, &start) != 2 || count < 1 || count > 512) return 5;
  for (int i = 0; i < count; ++i) {
    try { throw Item(start + i); } catch (Item const& object) { sum += object.value; }
    if (std::uncaught_exceptions() != 0) return 6;
  }
  int final = std::uncaught_exceptions();
  std::printf("loop %d destroyed %u final %d\\n", sum, destroyed, final);
  return count == 128 && start == 17 && sum == 10304 && destroyed == 128 && final == 0 ? 0 : 7;
}
`,
  },
  {
    name: 'noexcept-terminate', rtti: false, stdout: 'terminate\n', exitCode: 67,
    code: `#include <cstdio>
#include <cstdlib>
#include <exception>
static void terminate_handler() { std::puts("terminate"); std::fflush(stdout); std::_Exit(67); }
__attribute__((noinline)) void forbidden_throw() noexcept { throw 81; }
int main() { std::set_terminate(terminate_handler); forbidden_throw(); return 8; }
`,
  },
  {
    name: 'rtti-failures', rtti: true, stdout: 'rtti 3\n',
    code: `#include <cstdio>
#include <typeinfo>
struct Base { virtual ~Base() {} };
struct Derived : Base {};
int main() {
  Base base; unsigned caught = 0;
  try { (void)dynamic_cast<Derived&>(base); } catch (std::bad_cast const&) { caught |= 1; }
  Base* absent = nullptr;
  try { (void)typeid(*absent); } catch (std::bad_typeid const&) { caught |= 2; }
  std::printf("rtti %u\\n", caught);
  return caught == 3 ? 0 : 9;
}
`,
  },
];

export const exceptionRuntimeCases = definitions.flatMap((fixture) => ['0', '2'].map(optimization => ({
  id: `eh-runtime-${fixture.name}-o${optimization}`,
  kind: 'gnu-exception-runtime',
  request: { language: 'cpp', standard: 'c++17', optimization,
    exceptions: true, rtti: fixture.rtti, code: fixture.code },
  run: { stdin: fixture.stdin ?? '', args: [] },
  stdout: fixture.stdout, stderr: '', exitCode: fixture.exitCode ?? 0,
})));
