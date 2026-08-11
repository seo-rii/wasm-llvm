package main

import (
	"bufio"
	_ "embed"
	"fmt"
	"os"
	"strings"
)

//go:embed greeting.txt
var greeting string

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
	return fmt.Sprintf("%s %s count=%d total=%d", strings.TrimSpace(greeting), value.name, counts["values"], total)
}

func main() {
	name := "world"
	scanner := bufio.NewScanner(os.Stdin)
	if scanner.Scan() {
		if candidate := strings.TrimSpace(scanner.Text()); candidate != "" {
			name = candidate
		}
	}
	var value greeter = person{name: name, values: []int{1, 2}}
	added, multiplied, cppAssembly := nativeValues()
	fmt.Printf("%s cgo=%d/%d cxxasm=%d\n", value.greeting(), added, multiplied, cppAssembly)
}
