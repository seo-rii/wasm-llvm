#include <stdio.h>

typedef struct DebugPair {
	int left;
	int right;
} DebugPair;

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
	int values[3] = {2, 4, 6};
	DebugPair pair = {values[0], values[2]};
	int *middle = &values[1];
	int total = accumulate(seed);
	printf("total=%d\n", total);
	(void)pair;
	(void)middle;
	return total == 15 ? 0 : 1;
}
