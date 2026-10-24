#include <stdint.h>
#include <stdio.h>

_Static_assert(sizeof(void *) == 8 && sizeof(long) == 8, "Linux x86-64 LP64");
_Static_assert(__SIZEOF_LONG_DOUBLE__ == 16, "GNU/Linux long double layout");

int main(void) {
    int64_t a, b;
    if (scanf("%ld %ld", &a, &b) != 2) return 2;
    printf("%ld\n", a * 3 + b);
    return 0;
}
