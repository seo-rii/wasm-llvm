package main

/*
#cgo CFLAGS: -DTINYGO_C_FLAG=17 -Iinclude
#cgo CXXFLAGS: -std=c++20
#include <cgo-contract.h>
static int tinygo_cgo_flag(void) { return TINYGO_C_FLAG; }
*/
import "C"

func main() {
	println("cgo-flags", int(C.tinygo_cgo_flag()))
}
