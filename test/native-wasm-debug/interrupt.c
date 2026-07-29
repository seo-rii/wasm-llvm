int main(void) {
	volatile int value = 0;
	for (;;) {
		value += 1;
	}
}
