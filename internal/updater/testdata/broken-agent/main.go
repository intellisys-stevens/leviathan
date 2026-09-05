// Deliberately fails only startup. Used exclusively by disposable-host tests.
package main

import (
	"fmt"
	"os"
)

func main() {
	for _, arg := range os.Args[1:] {
		switch arg {
		case "version":
			fmt.Println(`{"version":"0.4.2","commit":"2222222222222222222222222222222222222222","buildDate":"2026-09-05T00:00:00Z"}`)
			return
		case "config-check":
			fmt.Println(`{"valid":true,"configProfile":"leviathan-config-v1","stateProfile":"leviathan-state-v1"}`)
			return
		}
	}
	os.Exit(1)
}
