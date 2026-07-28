#include <stdio.h>

volatile int global_bias = 3;

__attribute__((noinline)) int accumulate(int n) {
	int doubled = n * 2;
	if (n <= 1) {
		int base = doubled + global_bias;
		return base;
	}

	int child = accumulate(n - 1);
	int result = child + doubled;
	return result;
}

int main(void) {
	int seed = 3;
	int total = accumulate(seed);
	printf("total=%d\n", total);
	return total == 15 ? 0 : 1;
}
