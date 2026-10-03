package main

import "core:bufio"
import "core:fmt"
import "core:os"
import "core:strconv"
import "core:strings"

main :: proc() {
	reader: bufio.Reader
	bufio.reader_init(&reader, os.to_reader(os.stdin))
	defer bufio.reader_destroy(&reader)
	values := make([dynamic]i64)
	defer delete(values)

	for {
		line, err := bufio.reader_read_string(&reader, '\n')
		if len(line) > 0 {
			value, ok := strconv.parse_i64(strings.trim_space(line))
			delete(line)
			if !ok {
				fmt.eprintln("invalid integer")
				os.exit(2)
			}
			append(&values, value)
		}
		if err == .EOF { break }
		if err != .None {
			fmt.eprintln("input error")
			os.exit(3)
		}
	}
	stats := summarize(values[:])
	fmt.printf("count=%d sum=%d\n", stats.count, stats.total)
}
