import os
import strconv

struct Greeting {
	name string
}

fn (g &Greeting) text() string {
	return 'Hello, ${g.name}!'
}

fn parse_sum(line string) !int {
	mut total := 0
	for field in line.fields() {
		total += strconv.atoi(field)!
	}
	return total
}

fn main() {
	greeting := &Greeting{
		name: os.get_line()
	}
	println(greeting.text())
	println('V stdin: ${os.get_line()}')
	total := parse_sum(os.get_line()) or {
		eprintln(err)
		exit(2)
	}
	squares := []int{len: 5, init: (index + 1) * (index + 1)}
	println('sum=${total} squares=${squares} map=${{
		'k': 1.5
	}}')
	println('eof=${os.get_line() == ''}')
}
