// Test-only libatomic ABI providers. These ordinary loads/stores are deliberately
// single-threaded and MUST NOT be installed or advertised as an atomic runtime.
export const cases = [
  { width: 1, type: 'unsigned char', first: '171', second: '205', third: '239' },
  { width: 2, type: 'unsigned short', first: '43981', second: '52719', third: '61439' },
  { width: 4, type: 'unsigned int', first: '2882400001U', second: '3454992675U', third: '4026531841U' },
  { width: 8, type: 'unsigned long long', first: '12379813738877118345ULL', second: '14839080548208967681ULL', third: '17293822569102704641ULL' },
].flatMap(({ width, type, first, second, third }) => ['0', '2'].map(optimization => ({
  id: `atomic-libcall-abi-${width}-o${optimization}`,
  request: {
    language: 'c', standard: 'gnu11', optimization,
    code: `#include <stdio.h>
typedef ${type} value_t;
extern unsigned abi_calls, abi_bad_orders;
int main(void) {
  value_t value = ${first}, expected = 0;
  if (__atomic_compare_exchange_n(&value, &expected, (value_t)${second}, 0,
        __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)) return 11;
  if (value != (value_t)${first} || expected != value) return 12;
  if (!__atomic_compare_exchange_n(&value, &expected, (value_t)${second}, 0,
        __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)) return 13;
  if (value != (value_t)${second} || expected != (value_t)${first}) return 14;
  expected = value;
  if (!__atomic_compare_exchange_n(&value, &expected, (value_t)${third}, 1,
        __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)) return 15;
  if (value != (value_t)${third} || expected != (value_t)${second}) return 16;
  if (abi_calls != 3 || abi_bad_orders) return 17;
  printf("libatomic ABI ${width} %u\\n", abi_calls);
  return 0;
}
`,
    files: [{ path: 'provider.c', contents: `/* ABI fixture only: NOT an atomic implementation. */
typedef ${type} value_t;
unsigned abi_calls, abi_bad_orders;
_Bool abi_cas(volatile void *, void *, value_t, int, int)
  __asm__("__atomic_compare_exchange_${width}");
_Bool abi_cas(volatile void *pointer, void *expected, value_t desired,
              int success_order, int failure_order) {
  volatile value_t *p = pointer;
  value_t *e = expected;
  ++abi_calls;
  if (success_order != 4 || failure_order != 2) ++abi_bad_orders;
  if (*p != *e) { *e = *p; return 0; }
  *p = desired;
  return 1;
}
` }],
    sources: ['provider.c'],
  },
  stdin: '', stdout: `libatomic ABI ${width} 3\n`,
})));
