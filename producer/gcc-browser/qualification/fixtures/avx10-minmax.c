#include <immintrin.h>

#pragma GCC target("avx10.2")
__m128 minmax4(__m128 a, __m128 b) {
    return _mm_minmax_ps(a, b, 0);
}
