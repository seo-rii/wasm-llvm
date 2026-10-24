#include <limits.h>
#include <stdint.h>
#include <stdio.h>

_Static_assert(sizeof(void *) == 8 && sizeof(long) == 8, "Linux x86-64 LP64");
_Static_assert(__SIZEOF_LONG_DOUBLE__ == 16, "GNU/Linux long double layout");
_Static_assert(PATH_MAX > 0 && MB_LEN_MAX == 16, "limits.h delegates to GNU libc");
_Static_assert(UINTPTR_MAX == UINT64_MAX, "stdint.h provides Linux x86-64 types");

int main(void) {
    int64_t a, b;
    if (scanf("%ld %ld", &a, &b) != 2) return 2;
    printf("%ld\n", a * 3 + b);
    return 0;
}
