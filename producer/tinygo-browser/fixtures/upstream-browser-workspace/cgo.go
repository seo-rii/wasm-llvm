package main

/*
#cgo CXXFLAGS: -DTINYGO_CXX_SCALE=3
#cgo LDFLAGS: -L${SRCDIR}
int tinygo_inline_add(int a, int b) { return a + b; }
int tinygo_external_mul(int a, int b);
int tinygo_cpp_asm_mix(int a, int b);
*/
import "C"

func nativeValues() (int, int, int) {
	return int(C.tinygo_inline_add(2, 3)), int(C.tinygo_external_mul(4, 5)), int(C.tinygo_cpp_asm_mix(3, 4))
}
