// leviathan-updater is a separate executable so replacing or crashing the
// monitored agent cannot terminate the transaction coordinator.
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/updater"
)

var Version = "dev"

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if e := execute(ctx, os.Args[1:], os.Stdout, os.Stderr); e != nil {
		fmt.Fprintln(os.Stderr, "leviathan-updater:", e)
		os.Exit(1)
	}
}
func execute(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("leviathan-updater", flag.ContinueOnError)
	flags.SetOutput(stderr)
	configFile := flags.String("config", "/etc/leviathan-updater/config.json", "root-owned local configuration file")
	if e := flags.Parse(args); e != nil {
		return e
	}
	remaining := flags.Args()
	if len(remaining) == 0 {
		return errors.New("command required: run, recover, status, enroll, adopt, version")
	}
	command := remaining[0]
	if command == "version" {
		if len(remaining) != 1 {
			return errors.New("unexpected version arguments")
		}
		_, e := fmt.Fprintln(stdout, Version)
		return e
	}
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		return errors.New("the managed updater requires Linux and root")
	}
	config, e := updater.LoadConfig(*configFile)
	if e != nil {
		return e
	}
	client, e := updater.NewClient(config, nil)
	if e != nil {
		return e
	}
	defer client.Close()
	engine, e := updater.NewEngine(config, client, updater.NewSystemdService(config), updater.Options{})
	if e != nil {
		return e
	}
	sub := flag.NewFlagSet(command, flag.ContinueOnError)
	sub.SetOutput(stderr)
	switch command {
	case "adopt":
		binary := sub.String("binary", "/usr/local/bin/leviathan", "existing local agent binary")
		allowPreview := sub.Bool("allow-preview", false, "explicitly adopt a recognized preview while preventing downgrade")
		if e = sub.Parse(remaining[1:]); e != nil {
			return e
		}
		if sub.NArg() != 0 {
			return errors.New("unexpected adopt arguments")
		}
		if e = engine.Adopt(ctx, *binary, *allowPreview); e != nil {
			return e
		}
		return engine.Status(ctx, stdout)
	case "enroll":
		tokenFile := sub.String("token-file", "", "private file containing one-use enrollment token")
		if e = sub.Parse(remaining[1:]); e != nil {
			return e
		}
		if sub.NArg() != 0 || *tokenFile == "" {
			return errors.New("enroll requires --token-file")
		}
		if e = client.Enroll(ctx, *tokenFile); e != nil {
			return e
		}
		_, e = fmt.Fprintln(stdout, "Updater enrolled for the configured host.")
		return e
	case "recover", "status", "run":
		if len(remaining) != 1 {
			return errors.New("unexpected command arguments")
		}
	default:
		return errors.New("unknown updater command")
	}
	if command == "recover" {
		return engine.RecoverOffline(ctx)
	}
	if command == "status" {
		return engine.Status(ctx, stdout)
	}
	backoff := 15 * time.Second
	var previous string
	for ctx.Err() == nil {
		// Tick first: local recovery/result reporting remains independent of
		// renewal or control-plane availability.
		err := engine.Tick(ctx)
		renewErr := client.Renew(ctx)
		if err == nil {
			err = renewErr
		}
		code := ""
		if err != nil {
			code = err.Error()
			if errors.Is(err, updater.ErrRecoveryRequired) {
				code = "recovery_required"
			}
			if code != previous {
				fmt.Fprintln(stderr, "Updater action unavailable:", code)
			}
			if errors.Is(err, updater.ErrRecoveryRequired) {
				backoff = 15 * time.Second
			} else if backoff < 150*time.Second {
				backoff *= 2
			} else {
				backoff = 5 * time.Minute
			}
		} else {
			backoff = 15 * time.Second
			if previous != "" {
				fmt.Fprintln(stderr, "Updater control connection restored.")
			}
		}
		previous = code
		delay := jitter(backoff)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
	return nil
}
func jitter(d time.Duration) time.Duration {
	n, e := rand.Int(rand.Reader, big.NewInt(2001))
	if e != nil {
		return d
	}
	return d + time.Duration(int64(d)*(n.Int64()-1000)/10000)
}
