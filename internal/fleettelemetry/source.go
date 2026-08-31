// Package fleettelemetry selects the strongest explicitly authorized
// telemetry path for one fleet instance without changing the local Leviathan
// agent contract.
package fleettelemetry

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/fleet"
)

var (
	ErrInvalidConfiguration = errors.New("fleet telemetry source configuration is invalid")
	ErrUnavailable          = errors.New("fleet telemetry source is unavailable")
)

var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// UplinkRegistry is implemented by fleetuplink.Registry. Authentication and
// authorization happen before values enter that registry.
type UplinkRegistry interface {
	Get(projectID, instanceUUID string, now time.Time) (fleet.AgentSample, bool)
}

type Options struct {
	ProjectID string
	Uplink    UplinkRegistry
	Exact     fleet.AgentSource
	Console   fleet.AgentSource

	// ExactInstanceUUIDs identifies trusted pull bindings. An explicit binding
	// is authoritative: its failure is never hidden by a lower-fidelity source.
	ExactInstanceUUIDs []string
	Clock              func() time.Time
}

type Source struct {
	projectID string
	uplink    UplinkRegistry
	exact     fleet.AgentSource
	console   fleet.AgentSource
	exactUUID map[string]struct{}
	clock     func() time.Time
}

var _ fleet.AgentSource = (*Source)(nil)

func New(options Options) (*Source, error) {
	if options.Exact == nil && options.Console == nil && options.Uplink == nil {
		return nil, ErrInvalidConfiguration
	}
	if options.Uplink != nil && !validIdentifier(options.ProjectID) {
		return nil, ErrInvalidConfiguration
	}
	exactUUIDs := make(map[string]struct{}, len(options.ExactInstanceUUIDs))
	for _, instanceUUID := range options.ExactInstanceUUIDs {
		if !canonicalUUID.MatchString(instanceUUID) || options.Exact == nil {
			return nil, ErrInvalidConfiguration
		}
		if _, duplicate := exactUUIDs[instanceUUID]; duplicate {
			return nil, ErrInvalidConfiguration
		}
		exactUUIDs[instanceUUID] = struct{}{}
	}
	clock := options.Clock
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC() }
	}
	return &Source{
		projectID: options.ProjectID,
		uplink:    options.Uplink,
		exact:     options.Exact,
		console:   options.Console,
		exactUUID: exactUUIDs,
		clock:     clock,
	}, nil
}

func (source *Source) Observe(ctx context.Context, instance fleet.Instance) (fleet.AgentSample, error) {
	if err := ctx.Err(); err != nil {
		return fleet.AgentSample{}, err
	}
	if source == nil {
		return fleet.AgentSample{}, ErrInvalidConfiguration
	}
	if _, bound := source.exactUUID[instance.UUID]; bound {
		return source.exact.Observe(ctx, instance)
	}
	if source.uplink != nil {
		now := source.clock().UTC()
		if now.IsZero() {
			return fleet.AgentSample{}, ErrInvalidConfiguration
		}
		if sample, ok := source.uplink.Get(source.projectID, instance.UUID, now); ok {
			return sample, nil
		}
	}
	if source.console != nil {
		return source.console.Observe(ctx, instance)
	}
	return fleet.AgentSample{}, ErrUnavailable
}

func validIdentifier(value string) bool {
	if value == "" || len(value) > 256 || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}
