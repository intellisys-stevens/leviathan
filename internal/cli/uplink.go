package cli

import (
	"fmt"
	"io"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/config"
	"github.com/intellisys-stevens/leviathan/internal/model"
	"github.com/intellisys-stevens/leviathan/internal/uplink"
)

// newConfiguredUplink can only subscribe to a caller-owned source. It has no
// provider or collector constructor, which keeps serve's existing collector as
// the single source of both local and uplink telemetry.
func newConfiguredUplink(cfg config.UplinkConfig, source uplink.SnapshotSource, build model.BuildInfo, onAttempt func(uplink.AttemptResult)) (*uplink.Runner, error) {
	return uplink.NewConfiguredRunner(uplink.Configuration{
		Enabled: cfg.Enabled, BaseURL: cfg.BaseURL, TokenFile: cfg.TokenFile, Interval: cfg.Interval,
	}, source, build, onAttempt)
}

func uplinkAttemptReporter(output io.Writer) func(uplink.AttemptResult) {
	if output == nil {
		output = io.Discard
	}
	return func(result uplink.AttemptResult) {
		if result.Err == nil {
			return
		}
		// Uplink errors are deliberately sanitized before they reach this
		// boundary. Never add the base URL, token file, or response body here.
		fmt.Fprintf(output, "Leviathan uplink: %v; next attempt in %s\n", result.Err, result.NextAttemptIn.Round(100*time.Millisecond))
	}
}
