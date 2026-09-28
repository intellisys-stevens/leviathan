package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/intellisys-stevens/leviathan/internal/cli"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := cli.Execute(ctx, os.Stdout, os.Stderr, os.Args[1:]); err != nil {
		cli.WriteError(os.Stderr, err)
		os.Exit(1)
	}
}
