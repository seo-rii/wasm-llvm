package main

/*
int tinygo_inline_add(int a, int b) { return a + b; }
int tinygo_external_mul(int a, int b);
*/
import "C"

func nativeValues() (int, int) {
	return int(C.tinygo_inline_add(2, 3)), int(C.tinygo_external_mul(4, 5))
}
