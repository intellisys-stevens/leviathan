package attribution

import (
	"context"
	"fmt"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
	"github.com/intellisys-stevens/leviathan/internal/provider"
)

// Provider decorates telemetry with the latest optional attribution inventory.
// Bridge failures never fail or delay the underlying GPU sample.
type Provider struct {
	base        provider.Provider
	client      *Client
	checkpoint  *CheckpointReader
	resolver    bindingResolver
	lastRefresh string
}

func (p *Provider) WithCheckpoint(path string) *Provider {
	if path != "" {
		p.checkpoint = NewCheckpointReader(path)
	}
	return p
}

func NewProvider(base provider.Provider, client *Client) *Provider {
	return &Provider{base: base, client: client}
}

func (p *Provider) Name() string { return p.base.Name() }

func (p *Provider) Open(ctx context.Context) error {
	if err := p.base.Open(ctx); err != nil {
		return err
	}
	p.client.Start(ctx)
	if p.checkpoint != nil {
		p.checkpoint.Start(ctx)
	}
	return nil
}

func (p *Provider) Sample(ctx context.Context, at time.Time) (model.Snapshot, error) {
	value, processScopes, modern := p.client.inventory(at)
	cp := checkpointObservation{Reason: "checkpoint_disabled"}
	if p.checkpoint != nil {
		cp = p.checkpoint.Current(at)
	}
	token := refreshToken(modern, cp)
	if token != p.lastRefresh {
		if refresher, ok := p.base.(provider.TopologyRefresher); ok {
			refresher.RefreshTopology()
		}
		p.lastRefresh = token
	}
	snapshot, err := p.base.Sample(ctx, at)
	if err != nil {
		return snapshot, err
	}
	after, _, next := p.client.inventory(at)
	if p.checkpoint != nil {
		nextCP := p.checkpoint.Current(at)
		if nextCP.Revision != cp.Revision {
			cp.Reason = "binding_mismatch"
		}
		if nextCP.Reason != "" {
			cp.Reason = nextCP.Reason
		}
	}
	if refreshToken(next, checkpointObservation{}) != refreshToken(modern, checkpointObservation{}) || after.Status != value.Status {
		value.Status = model.AttributionStale
	}
	p.resolver.resolve(&value, modern, snapshot, cp)
	for index := range snapshot.Processes {
		snapshot.Processes[index].WorkloadRef = ""
		if workloadRef, exists := processScopes[snapshot.Processes[index].ScopeRef]; exists {
			snapshot.Processes[index].WorkloadRef = workloadRef
		}
	}
	snapshot.Attribution = &value
	return snapshot, nil
}

func (p *Provider) Capabilities() model.Capabilities { return p.base.Capabilities() }

func (p *Provider) Close() error {
	p.client.Close()
	if p.checkpoint != nil {
		p.checkpoint.Close()
	}
	return p.base.Close()
}

func refreshToken(d *DocumentV2, cp checkpointObservation) string {
	if d == nil {
		return fmt.Sprint("legacy/", cp.Revision)
	}
	return fmt.Sprintf("%s/%d/%d", d.InstanceID, d.Revision, cp.Revision)
}
