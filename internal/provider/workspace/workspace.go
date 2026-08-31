// Package workspace decorates GPU telemetry with the GPU-connected processes
// visible in the caller's current PID namespace.
package workspace

import (
	"context"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
	workspaceprocess "github.com/intellisys-stevens/leviathan/internal/process"
	"github.com/intellisys-stevens/leviathan/internal/provider"
)

type Provider struct {
	base    provider.Provider
	scanner InventoryScanner
	options Options

	mu             sync.RWMutex
	scanMu         sync.Mutex
	procState      model.ProviderState
	inventory      workspaceprocess.Inventory
	inventoryAt    time.Time
	inventoryReady bool
}

type Options struct {
	InventoryInterval time.Duration
}

type InventoryScanner interface {
	Scan() workspaceprocess.Inventory
}

func New(base provider.Provider, scanner InventoryScanner, options ...Options) *Provider {
	configured := Options{InventoryInterval: 2 * time.Second}
	if len(options) > 0 {
		configured = options[0]
		if configured.InventoryInterval <= 0 {
			configured.InventoryInterval = 2 * time.Second
		}
	}
	return &Provider{
		base: base, scanner: scanner, options: configured,
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
	inventory := p.processInventory(at)
	snapshot.Processes = inventory.Processes
	snapshot.Capabilities.Proc = inventory.Capability
	snapshot.Diagnostics = append(snapshot.Diagnostics, inventory.Diagnostics...)
	if snapshot.Diagnostics == nil {
		snapshot.Diagnostics = []model.Diagnostic{}
	}
	p.mu.Lock()
	p.procState = inventory.Capability
	p.mu.Unlock()
	return snapshot, nil
}

func (p *Provider) Close() error { return p.base.Close() }

func (p *Provider) processInventory(at time.Time) workspaceprocess.Inventory {
	if inventory, ok := p.cachedInventory(at); ok {
		return inventory
	}

	// Keep concurrent snapshot requests from launching duplicate /proc walks.
	p.scanMu.Lock()
	defer p.scanMu.Unlock()
	if inventory, ok := p.cachedInventory(at); ok {
		return inventory
	}

	inventory := p.scanner.Scan()
	p.mu.Lock()
	p.inventory = cloneInventory(inventory)
	p.inventoryAt = at
	p.inventoryReady = true
	p.mu.Unlock()
	return cloneInventory(inventory)
}

func (p *Provider) cachedInventory(at time.Time) (workspaceprocess.Inventory, bool) {
	p.mu.RLock()
	ready := p.inventoryReady
	inventoryAt := p.inventoryAt
	interval := p.options.InventoryInterval
	if ready && !at.Before(inventoryAt) && at.Sub(inventoryAt) < interval {
		inventory := cloneInventory(p.inventory)
		p.mu.RUnlock()
		return inventory, true
	}
	p.mu.RUnlock()
	return workspaceprocess.Inventory{}, false
}

func cloneInventory(inventory workspaceprocess.Inventory) workspaceprocess.Inventory {
	cloned := inventory
	cloned.Processes = append([]model.Process{}, inventory.Processes...)
	for index := range cloned.Processes {
		if inventory.Processes[index].StartTime != nil {
			startedAt := *inventory.Processes[index].StartTime
			cloned.Processes[index].StartTime = &startedAt
		}
	}
	cloned.Diagnostics = append([]model.Diagnostic{}, inventory.Diagnostics...)
	return cloned
}
