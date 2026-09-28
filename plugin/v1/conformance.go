package v1

import (
	"context"
	"fmt"
	"sort"
	"time"
)

// CheckSource exercises a source's advertised capabilities twice. It owns the
// source lifecycle and is intended for plugin authors' tests, not monitoring.
func CheckSource(ctx context.Context, source Source) error {
	if err := source.Open(ctx); err != nil {
		return err
	}
	defer source.Close()
	manifest := source.Manifest()
	if err := manifest.Validate(); err != nil {
		return err
	}
	capabilities := make([]string, 0, len(manifest.Capabilities))
	for capability := range manifest.Capabilities {
		capabilities = append(capabilities, string(capability))
	}
	sort.Strings(capabilities)
	for _, name := range capabilities {
		capability := Capability(name)
		var previous Observation
		for i := 0; i < 2; i++ {
			now := time.Now().UTC()
			observation, err := source.Read(ctx, capability, now)
			if err != nil {
				return fmt.Errorf("%s: %w", capability, err)
			}
			if err = observation.ValidateAt(time.Now().UTC()); err != nil {
				return fmt.Errorf("%s: %w", capability, err)
			}
			if observation.Capability != capability {
				return fmt.Errorf("%s: response capability mismatch", capability)
			}
			if i > 0 && (observation.InstanceID != previous.InstanceID || observation.SessionID != previous.SessionID || observation.Revision < previous.Revision || observation.ObservedAt.Before(previous.ObservedAt)) {
				return fmt.Errorf("%s: source changed identity or moved backwards", capability)
			}
			previous = observation
		}
	}
	return nil
}
