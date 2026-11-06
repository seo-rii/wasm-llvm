#ifndef __wasm_tls__
#error the explicit TLS profile is required
#endif
#ifdef __cplusplus
#define TLS thread_local
#define EXTERN_C extern "C"
#else
#define TLS _Thread_local
#define EXTERN_C
#endif
TLS int initialized = 7;
TLS unsigned zeroed;
TLS unsigned char aligned[64] __attribute__((aligned(64)));
#pragma GCC push_options
#pragma GCC optimize ("O2")
static __attribute__((noinline)) int read_tls_optimized(void) { return initialized; }
#pragma GCC pop_options
static __attribute__((noinline,optimize("O0"))) void update_tls_unoptimized(void)
{
  initialized += 13;
  zeroed = 29;
  aligned[63] = 31;
}
EXTERN_C int probe(void)
{
  if (read_tls_optimized() != 7 || zeroed != 0 || (unsigned)&aligned % 64)
    return 1;
  for (unsigned i = 0; i < 64; ++i)
    if (aligned[i]) return 2;
  update_tls_unoptimized();
  return initialized != 20 || zeroed != 29 || aligned[63] != 31;
}
