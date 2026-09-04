package provider

import (
	"context"
	"errors"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

// ErrUnavailable marks an optional provider that cannot exist on this host.
// Collectors may keep other telemetry domains healthy while periodically
// retrying it. Runtime failures after a provider opens must not wrap this.
var ErrUnavailable = errors.New("provider unavailable")

type Provider interface {
	Name() string
	Open(context.Context) error
	Sample(context.Context, time.Time) (model.Snapshot, error)
	Capabilities() model.Capabilities
	Close() error
}
