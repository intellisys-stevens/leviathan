package attribution

import (
	"context"
	"time"

	"github.com/intellisys-stevens/miglens/internal/model"
	"github.com/intellisys-stevens/miglens/internal/provider"
)

// Provider decorates telemetry with the latest optional attribution inventory.
// Bridge failures never fail or delay the underlying GPU sample.
type Provider struct {
	base   provider.Provider
	client *Client
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
	return nil
}

func (p *Provider) Sample(ctx context.Context, at time.Time) (model.Snapshot, error) {
	snapshot, err := p.base.Sample(ctx, at)
	if err != nil {
		return snapshot, err
	}
	attribution := p.client.Current(at)
	snapshot.Attribution = &attribution
	return snapshot, nil
}

func (p *Provider) Capabilities() model.Capabilities { return p.base.Capabilities() }

func (p *Provider) Close() error {
	p.client.Close()
	return p.base.Close()
}
