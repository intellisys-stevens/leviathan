// Package workspace decorates GPU telemetry with the GPU-connected processes
// visible in the caller's current PID namespace.
package workspace

import (
	"context"
	"sync"
	"time"

	"github.com/miglens/miglens/internal/model"
	workspaceprocess "github.com/miglens/miglens/internal/process"
	"github.com/miglens/miglens/internal/provider"
)

type Provider struct {
	base    provider.Provider
	scanner *workspaceprocess.Scanner

	mu        sync.RWMutex
	procState model.ProviderState
}

func New(base provider.Provider, scanner *workspaceprocess.Scanner) *Provider {
	return &Provider{
		base: base, scanner: scanner,
		procState: model.ProviderState{
			Name: "/proc GPU clients (current PID namespace)", Available: false,
			Status: model.StatusStale, Message: "GPU process inventory has not been sampled yet",
		},
	}
}

func (p *Provider) Name() string                   { return p.base.Name() }
func (p *Provider) Open(ctx context.Context) error { return p.base.Open(ctx) }

func (p *Provider) Capabilities() model.Capabilities {
	capabilities := p.base.Capabilities()
	p.mu.RLock()
	capabilities.Proc = p.procState
	p.mu.RUnlock()
	return capabilities
}

func (p *Provider) Sample(ctx context.Context, at time.Time) (model.Snapshot, error) {
	snapshot, err := p.base.Sample(ctx, at)
	if err != nil {
		return snapshot, err
	}
	inventory := p.scanner.Scan()
	snapshot.Processes = inventory.Processes
	snapshot.Capabilities.Proc = inventory.Capability
	snapshot.Diagnostics = append(snapshot.Diagnostics, inventory.Diagnostics...)
	p.mu.Lock()
	p.procState = inventory.Capability
	p.mu.Unlock()
	return snapshot, nil
}

func (p *Provider) Close() error { return p.base.Close() }
