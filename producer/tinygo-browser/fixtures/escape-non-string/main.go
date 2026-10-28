package main

import (
	"hash/maphash"
	"runtime"
)

type key struct {
	pointer *int
	text    string
	number  int
}

//go:noinline
func grow(depth int) int {
	var frame [32]byte
	frame[0] = byte(depth)
	if depth == 0 {
		runtime.Gosched()
		runtime.GC()
		return int(frame[0])
	}
	return int(frame[0]) + grow(depth-1)
}

//go:noinline
func pointerCase(seed maphash.Seed) bool {
	value := 73
	hash := maphash.Comparable(seed, &value)
	grow(64)
	return value == 73 && hash == maphash.Comparable(seed, &value)
}

//go:noinline
func nestedCase(seed maphash.Seed) bool {
	value := 91
	k := key{&value, "text", 7}
	hash := maphash.Comparable(seed, k)
	grow(64)
	return value == 91 && hash == maphash.Comparable(seed, k)
}

//go:noinline
func interfaceCase(seed maphash.Seed) bool {
	value := 113
	var boxed any = &value
	hash := maphash.Comparable(seed, boxed)
	grow(64)
	return value == 113 && hash == maphash.Comparable(seed, boxed)
}

//go:noinline
func arrayCase(seed maphash.Seed) bool {
	value := 127
	keys := [2]key{{&value, "first", 7}, {nil, "second", 9}}
	hash := maphash.Comparable(seed, keys)
	grow(64)
	return value == 127 && hash == maphash.Comparable(seed, keys)
}

//go:noinline
func scalarCase(seed maphash.Seed) bool {
	return maphash.Comparable(seed, 42) == maphash.Comparable(seed, 42)
}

//go:noinline
func stringCase(seed maphash.Seed) bool {
	return maphash.Comparable(seed, "same") == maphash.Comparable(seed, "same")
}

func check(name string, ok bool) {
	println(name, ok)
	if !ok {
		panic(name)
	}
}

func main() {
	seed := maphash.MakeSeed()
	println("before comparable")
	check("pointer", pointerCase(seed))
	check("nested", nestedCase(seed))
	check("interface", interfaceCase(seed))
	check("array", arrayCase(seed))
	check("scalar", scalarCase(seed))
	check("string", stringCase(seed))
	println("done")
}
