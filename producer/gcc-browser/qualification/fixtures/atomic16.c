#include <stdatomic.h>
#include <stdio.h>

typedef struct { unsigned long first, second; } Pair;
_Static_assert(sizeof(Pair) == 16, "expected a 16-byte pair");
static _Atomic(Pair) shared;

int main(void) {
    Pair input;
    if (scanf("%lu %lu", &input.first, &input.second) != 2) return 2;
    atomic_store(&shared, input);
    Pair result = atomic_load(&shared);
    printf("%lu %lu\n", result.first, result.second);
    return 0;
}
