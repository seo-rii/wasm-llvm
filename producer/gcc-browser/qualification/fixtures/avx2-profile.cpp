#include <immintrin.h>

extern "C" __attribute__((noinline, used))
void profile_avx2_add(int *out, const int *a, const int *b) {
    _mm256_storeu_si256(reinterpret_cast<__m256i *>(out),
        _mm256_add_epi32(_mm256_loadu_si256(reinterpret_cast<const __m256i *>(a)),
                         _mm256_loadu_si256(reinterpret_cast<const __m256i *>(b))));
}

extern "C" __attribute__((noinline, used))
void profile_fma(float *out, const float *a, const float *b, const float *c) {
    _mm256_storeu_ps(out, _mm256_fmadd_ps(_mm256_loadu_ps(a), _mm256_loadu_ps(b),
                                       _mm256_loadu_ps(c)));
}
