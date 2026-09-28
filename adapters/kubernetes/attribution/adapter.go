package attribution

import (
	"context"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/model"
)

// Adapter observes Kubernetes attribution independently of GPU initialization.
// Kubernetes credentials remain in the bridge; NVIDIA checkpoints are read only
// by this host-side adapter. Open's context bounds initialization, not lifetime.
type Adapter struct {
	client      *Client
	checkpoint  *CheckpointReader
	mu          sync.Mutex
	resolver    bindingResolver
	lastRefresh string
	cancel      context.CancelFunc
}

func NewAdapter(client *Client, checkpointPath string) *Adapter {
	a := &Adapter{client: client}
	if checkpointPath != "" {
		a.checkpoint = NewCheckpointReader(checkpointPath)
	}
	return a
}

func (a *Adapter) Open(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel != nil {
		return nil
	}
	// An unavailable optional bridge remains observable as unavailable state.
	// Poll has the client's HTTP deadline and the caller's initialization bound.
	_ = a.client.Poll(ctx)
	lifetime, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	a.client.Start(lifetime)
	if a.checkpoint != nil {
		a.checkpoint.Start(lifetime)
	}
	return nil
}

// NeedsTopologyRefresh coalesces allocation/checkpoint changes. Call it before
// sampling topology when an implementation supports allocation-driven rescans.
func (a *Adapter) NeedsTopologyRefresh(at time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	_, _, modern := a.client.inventory(at)
	cp := checkpointObservation{Reason: "checkpoint_disabled"}
	if a.checkpoint != nil {
		cp = a.checkpoint.Current(at)
	}
	token := refreshToken(modern, cp)
	changed := token != a.lastRefresh
	a.lastRefresh = token
	return changed
}

// Observe projects current attribution onto an immutable topology observation.
// It never advances GPU freshness or treats an unavailable join as free capacity.
func (a *Adapter) Observe(snapshot model.Snapshot) model.Snapshot {
	observed, _ := a.ObserveWithScopes(snapshot)
	return observed
}

// ObserveWithScopes also exposes opaque host execution-scope joins.
func (a *Adapter) ObserveWithScopes(snapshot model.Snapshot) (model.Snapshot, map[string]string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	at := a.client.options.Now().UTC()
	value, processScopes, modern := a.client.inventory(at)
	initialStatus := value.Status
	cp := checkpointObservation{Reason: "checkpoint_disabled"}
	if a.checkpoint != nil {
		cp = a.checkpoint.Current(at)
	}
	a.resolver.resolve(&value, modern, snapshot, cp)
	after, _, next := a.client.inventory(at)
	if a.checkpoint != nil {
		nextCP := a.checkpoint.Current(at)
		if nextCP.Revision != cp.Revision || nextCP.Reason != "" {
			if value.Status != model.AttributionUnavailable {
				value.Status = model.AttributionStale
			}
			value.Resolution = &model.AttributionResolution{Status: "unknown", ReasonCodes: []string{"binding_mismatch"}, Workloads: []model.WorkloadAssignmentResolution{}}
		}
	}
	if refreshToken(next, checkpointObservation{}) != refreshToken(modern, checkpointObservation{}) || after.Status != initialStatus {
		if value.Status != model.AttributionUnavailable {
			value.Status = model.AttributionStale
		}
		if value.Resolution == nil {
			resolution := CompleteResolution()
			value.Resolution = &resolution
		}
		value.Resolution.Status = "unknown"
		value.Resolution.ReasonCodes = uniqueReason(value.Resolution.ReasonCodes, "source_changed")
	}
	snapshot.Processes = append([]model.Process(nil), snapshot.Processes...)
	for index := range snapshot.Processes {
		snapshot.Processes[index].WorkloadRef = processScopes[snapshot.Processes[index].ScopeRef]
	}
	snapshot.Attribution = &value
	return snapshot, processScopes
}

func (a *Adapter) Close() error {
	a.mu.Lock()
	cancel := a.cancel
	a.cancel = nil
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	a.client.Close()
	if a.checkpoint != nil {
		a.checkpoint.Close()
	}
	return nil
}
