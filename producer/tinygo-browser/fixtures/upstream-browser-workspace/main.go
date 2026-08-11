package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"example.com/tinygo-browser/workspace/numbers"
)

type greeter interface {
	greeting() string
}

type person struct {
	name   string
	values []int
}

func (value person) greeting() string {
	counts := map[string]int{"values": len(value.values)}
	total := 0
	for _, number := range value.values {
		total += number
	}
	inline, external := nativeValues()
	return fmt.Sprintf(
		"hello %s count=%d total=%d cgo=%d/%d",
		value.name,
		counts["values"],
		total,
		inline,
		external,
	)
}

func main() {
	name := "world"
	scanner := bufio.NewScanner(os.Stdin)
	if scanner.Scan() {
		if candidate := strings.TrimSpace(scanner.Text()); candidate != "" {
			name = candidate
		}
	}
	var value greeter = person{name: name, values: numbers.Values()}
	fmt.Println(value.greeting())
}
