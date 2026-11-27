#include <atomic>
#include <cstdio>

struct Pair { unsigned long first, second; };
static_assert(sizeof(Pair) == 16);
static std::atomic<Pair> shared;

int main() {
    Pair input;
    if (std::scanf("%lu %lu", &input.first, &input.second) != 2) return 2;
    shared.store(input);
    Pair result = shared.load();
    std::printf("%lu %lu\n", result.first, result.second);
}
