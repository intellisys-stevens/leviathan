package provider

import (
	"context"
	"errors"
	"time"

	"github.com/miglens/miglens/internal/model"
)

var ErrUnavailable = errors.New("provider unavailable")

type Provider interface {
	Name() string
	Open(context.Context) error
	Sample(context.Context, time.Time) (model.Snapshot, error)
	Capabilities() model.Capabilities
	Close() error
}
