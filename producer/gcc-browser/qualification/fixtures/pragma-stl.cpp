// These pragmas intentionally precede the headers. GCC 13 misapplies the target
// to implicitly generated functions, producing an allocator always_inline error.
#pragma GCC target("avx2")
#pragma GCC optimize("O3")
#include <cstdint>
#include <iostream>
#include <vector>

extern "C" __attribute__((noinline, used))
void pragma_stl_transform(const std::uint32_t *__restrict input,
                          std::uint32_t *__restrict output, std::size_t n) {
    for (std::size_t i = 0; i < n; ++i)
        output[i] = (input[i] * 1664525u + 1013904223u) ^ 0xa5a5a5a5u;
}

int main() {
    std::size_t n;
    std::uint32_t state;
    if (!(std::cin >> n >> state) || n > 4096) return 2;
    std::vector<std::uint32_t> input(n), output(n);
    for (auto &value : input) {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        value = state;
    }
    pragma_stl_transform(input.data(), output.data(), n);
    std::uint64_t sum = 0;
    std::uint32_t checksum = 0;
    for (auto value : output) { sum += value; checksum ^= value; }
    std::cout << sum << ' ' << checksum << '\n';
}
