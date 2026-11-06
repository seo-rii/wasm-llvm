
#ifndef __wasm_atomics__
#error missing atomics macro
#endif
#if __GCC_ATOMIC_CHAR_LOCK_FREE != 2 || __GCC_ATOMIC_SHORT_LOCK_FREE != 2 || __GCC_ATOMIC_INT_LOCK_FREE != 2 || __GCC_ATOMIC_LLONG_LOCK_FREE != 2
#error wrong lock-free macros
#endif
#ifdef __GCC_HAVE_SYNC_COMPARE_AND_SWAP_16
#error no native 128-bit atomics
#endif
#ifdef __cplusplus
#define ASSERT static_assert
extern "C" {
#else
#define ASSERT _Static_assert
#endif
ASSERT(__atomic_always_lock_free(1, 0), "QI lock free");
ASSERT(__atomic_always_lock_free(2, 0), "HI lock free");
ASSERT(__atomic_always_lock_free(4, 0), "SI lock free");
ASSERT(__atomic_always_lock_free(8, 0), "DI lock free");
ASSERT(!__atomic_always_lock_free(16, 0), "TI helper");
ASSERT(!__atomic_always_lock_free(4, (void *)1), "unaligned query");

#define CHECK(condition, code) do { if (!(condition)) return (code); } while (0)
#define OPERATIONS(T, N) \
__attribute__((noinline)) unsigned probe_##N(void) { \
  T high = (T)((T)1 << (8 * sizeof(T) - 1)); \
  volatile T v = high; T expected = high; \
  CHECK(__atomic_compare_exchange_n(&v, &expected, (T)(high | 3), 1, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE), 1); \
  CHECK(v == (T)(high | 3) && expected == high, 2); \
  expected = 0; \
  CHECK(!__atomic_compare_exchange_n(&v, &expected, (T)1, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST), 3); \
  CHECK(expected == (T)(high | 3) && v == expected, 4); \
  CHECK(__atomic_exchange_n(&v, high, __ATOMIC_RELAXED) == (T)(high | 3), 5); \
  CHECK(__atomic_fetch_add(&v, (T)1, __ATOMIC_RELAXED) == high, 6); \
  CHECK(__atomic_add_fetch(&v, (T)1, __ATOMIC_SEQ_CST) == (T)(high + 2), 7); \
  CHECK(__atomic_fetch_sub(&v, (T)3, __ATOMIC_ACQUIRE) == (T)(high + 2), 8); \
  CHECK(__atomic_sub_fetch(&v, (T)3, __ATOMIC_RELEASE) == (T)(high - 4), 9); \
  __atomic_store_n(&v, (T)0xf5, __ATOMIC_RELEASE); \
  CHECK(__atomic_load_n(&v, __ATOMIC_CONSUME) == (T)0xf5, 10); \
  CHECK(__atomic_fetch_and(&v, (T)0x5f, __ATOMIC_ACQ_REL) == (T)0xf5, 11); \
  CHECK(__atomic_and_fetch(&v, (T)0x3f, __ATOMIC_RELAXED) == (T)0x15, 12); \
  CHECK(__atomic_fetch_or(&v, (T)0x80, __ATOMIC_SEQ_CST) == (T)0x15, 13); \
  CHECK(__atomic_or_fetch(&v, (T)0x40, __ATOMIC_ACQUIRE) == (T)0xd5, 14); \
  CHECK(__atomic_fetch_xor(&v, (T)0x30, __ATOMIC_RELEASE) == (T)0xd5, 15); \
  CHECK(__atomic_xor_fetch(&v, (T)0xff, __ATOMIC_ACQ_REL) == (T)0x1a, 16); \
  CHECK(__atomic_fetch_nand(&v, (T)0x0f, __ATOMIC_RELAXED) == (T)0x1a, 17); \
  CHECK(v == (T)~(T)0x0a, 18); \
  T want = (T)~((T)~(T)0x0a & (T)0x55); \
  CHECK(__atomic_nand_fetch(&v, (T)0x55, __ATOMIC_SEQ_CST) == want, 19); \
  __atomic_store_n(&v, (T)~(T)0, __ATOMIC_RELAXED); \
  CHECK(__atomic_fetch_add(&v, (T)1, __ATOMIC_SEQ_CST) == (T)~(T)0 && v == 0, 20); \
  return 0; \
}
OPERATIONS(unsigned char, 1)
OPERATIONS(unsigned short, 2)
OPERATIONS(unsigned int, 4)
OPERATIONS(unsigned long long, 8)

#define SIGNED_CAS(T, N) \
__attribute__((noinline)) unsigned signed_##N(void) { \
  volatile T v = (T)-1; T expected = (T)-1; \
  CHECK(__atomic_compare_exchange_n(&v, &expected, (T)-7, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST), 1); \
  CHECK(v == (T)-7 && expected == (T)-1, 2); \
  expected = (T)-1; \
  CHECK(!__atomic_compare_exchange_n(&v, &expected, (T)3, 1, __ATOMIC_ACQUIRE, __ATOMIC_ACQUIRE), 3); \
  CHECK(expected == (T)-7 && v == (T)-7, 4); \
  return 0; \
}
SIGNED_CAS(signed char, 1)
SIGNED_CAS(short, 2)
SIGNED_CAS(int, 4)
SIGNED_CAS(long long, 8)

__attribute__((noinline)) unsigned dynamic_order(volatile unsigned *p, int order) {
  return __atomic_fetch_add(p, 1u, order);
}
unsigned probe(void) {
  unsigned r;
  if ((r=probe_1())) return 100+r;
  if ((r=probe_2())) return 200+r;
  if ((r=probe_4())) return 400+r;
  if ((r=probe_8())) return 800+r;
  if ((r=signed_1())) return 1100+r;
  if ((r=signed_2())) return 1200+r;
  if ((r=signed_4())) return 1400+r;
  if ((r=signed_8())) return 1800+r;
  volatile unsigned v=0;
  for (int order=0; order<=5; ++order) {
    if (dynamic_order(&v, order) != (unsigned)order) return 2000+order;
  }
  unsigned char flag=0;
  if (__atomic_test_and_set(&flag, __ATOMIC_ACQUIRE)) return 2100;
  if (!__atomic_test_and_set(&flag, __ATOMIC_RELAXED)) return 2101;
  __atomic_clear(&flag, __ATOMIC_RELEASE);
  if (flag) return 2102;
  __atomic_thread_fence(__ATOMIC_SEQ_CST);
  __atomic_signal_fence(__ATOMIC_SEQ_CST);
  return 0;
}
#ifdef __cplusplus
}
#endif
