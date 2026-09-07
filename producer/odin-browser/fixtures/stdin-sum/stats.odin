package main

Stats :: struct {
	count: int,
	total: i64,
}

sum :: proc(values: []$T) -> T {
	total: T
	for value in values { total += value }
	return total
}

summarize :: proc(values: []i64) -> Stats {
	return Stats{len(values), sum(values)}
}
