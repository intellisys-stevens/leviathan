package uplink

import (
	"fmt"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

// Configuration is the minimal serve-owned configuration needed to assemble
// an uploader. The caller must supply its already-running SnapshotSource.
type Configuration struct {
	Enabled   bool
	BaseURL   string
	TokenFile string
	Interval  time.Duration
}

// NewConfiguredRunner assembles an uploader around a caller-owned source. It
// cannot construct or start a collector, which keeps local publication and the
// uplink on the same immutable snapshot stream.
func NewConfiguredRunner(configuration Configuration, source SnapshotSource, build model.BuildInfo, onAttempt func(AttemptResult)) (*Runner, error) {
	if !configuration.Enabled {
		return nil, nil
	}
	credentials, err := NewFileTokenSource(configuration.TokenFile)
	if err != nil {
		return nil, fmt.Errorf("initialize uplink credential: %w", err)
	}
	client, err := NewClient(configuration.BaseURL, credentials, ClientOptions{})
	if err != nil {
		return nil, fmt.Errorf("initialize uplink client: %w", err)
	}
	runner, err := NewRunner(source, client, RunnerOptions{
		Interval: configuration.Interval, BuildInfo: build, OnAttempt: onAttempt,
	})
	if err != nil {
		return nil, fmt.Errorf("initialize uplink runner: %w", err)
	}
	return runner, nil
}
