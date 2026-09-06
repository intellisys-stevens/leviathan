// Test-only real CLI wrapper: metadata/config-check succeed, serve fails.
// Never included in a release archive or used outside disposable acceptance.
package main

import (
	"context"
	"os"

	"github.com/intellisys-stevens/leviathan/internal/cli"
)

func main() {
	for _, argument := range os.Args[1:] {
		if argument == "serve" {
			os.Exit(23)
		}
	}
	if err := cli.Execute(context.Background(), os.Stdout, os.Stderr, os.Args[1:]); err != nil {
		os.Exit(1)
	}
}
