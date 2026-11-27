#include <math.h>
#include <stdio.h>

int main(void) {
    double input;
    if (scanf("%lf", &input) != 1) return 2;
    printf("%.6f\n", sin(input));
    return 0;
}
