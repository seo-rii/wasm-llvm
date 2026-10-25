#include <immintrin.h>

// The translation unit is compiled at -O0 -march=x86-64. These options must
// come from GCC's pragmas. Every intrinsic consumes runtime pointer inputs.
#pragma GCC push_options
#pragma GCC target("avx2,fma")
#pragma GCC optimize("O3")

extern "C" __attribute__((noinline, used))
void avx2_add(int *out, const int *a, const int *b) {
    const __m256i x = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(a));
    const __m256i y = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(b));
    _mm256_storeu_si256(reinterpret_cast<__m256i *>(out), _mm256_add_epi32(x, y));
}

extern "C" __attribute__((noinline, used))
void fma_multiply_add(float *out, const float *a, const float *b, const float *c) {
    _mm256_storeu_ps(out, _mm256_fmadd_ps(_mm256_loadu_ps(a), _mm256_loadu_ps(b),
                                       _mm256_loadu_ps(c)));
}

extern "C" __attribute__((noinline, used))
int optimized_in_push(int x) {
    int result = x;
    for (int i = 0; i < 8; ++i) result += x;
    return result;
}

#pragma GCC pop_options

extern "C" __attribute__((noinline, used))
int unoptimized_after_pop(int x) {
    int result = x;
    for (int i = 0; i < 8; ++i) result += x;
    return result;
}

extern "C" __attribute__((noinline, used))
void baseline_after_pop(int *out, const int *a, const int *b) {
    for (int i = 0; i < 64; ++i) out[i] = a[i] + b[i];
}

// A separate O3 region proves pop_options restored the target, even when the
// vectorizer is enabled again. An AVX leak would permit YMM in this function.
#pragma GCC push_options
#pragma GCC optimize("O3")
extern "C" __attribute__((noinline, used))
void vectorized_baseline_after_pop(int *__restrict out,
                                   const int *__restrict a,
                                   const int *__restrict b) {
    for (int i = 0; i < 64; ++i) out[i] = a[i] + b[i];
}
#pragma GCC pop_options
