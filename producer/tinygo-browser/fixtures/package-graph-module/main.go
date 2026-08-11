package main

import (
	_ "embed"
	"fmt"

	"example.com/tinygo-browser/graphfixture/message"
)

//go:embed greeting.txt
var greeting string

func main() {
	fmt.Println(greeting[:len(greeting)-1], message.Platform())
}
