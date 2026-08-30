package fleet

import (
	"testing"
	"time"
)

type peerStubSource struct {
	state Snapshot
	ready bool
	ch    chan Snapshot
}

func (source *peerStubSource) Current() (Snapshot, bool) { return source.state, source.ready }

func (source *peerStubSource) Subscribe() (<-chan Snapshot, func()) {
	return source.ch, func() {}
}

func TestStaticPeersPrependDirectHostWithoutChangingDynamicState(t *testing.T) {
	now := time.Date(2026, time.August, 30, 20, 0, 0, 0, time.UTC)
	dynamic := Snapshot{
		SchemaVersion: SchemaVersion,
		Sequence:      4,
		ObservedAt:    now,
		Platforms: []PlatformObservation{{
			Platform:  Platform{ID: "jetstream", DisplayName: "Jetstream", Kind: PlatformKindOpenStack},
			Inventory: InventoryHealth{Status: InventoryAvailable, LastAttemptAt: now},
			Instances: make([]InstanceObservation, 0),
		}},
	}
	stub := &peerStubSource{state: dynamic, ready: true, ch: make(chan Snapshot, 1)}
	peers, err := NewStaticPeers(stub, []Platform{{
		ID: "nidhogg", DisplayName: "Nidhogg", Kind: PlatformKindHost, DashboardURL: "https://nidhogg.example.test/",
	}})
	if err != nil {
		t.Fatalf("NewStaticPeers() error = %v", err)
	}
	state, ok := peers.Current()
	if !ok || state.Sequence != 4 || len(state.Platforms) != 2 {
		t.Fatalf("decorated state = ready %v sequence %d platforms %d", ok, state.Sequence, len(state.Platforms))
	}
	if state.Platforms[0].Platform.ID != "nidhogg" || state.Platforms[0].Platform.DashboardURL != "https://nidhogg.example.test/" {
		t.Fatalf("static peer = %+v", state.Platforms[0].Platform)
	}
	if state.Platforms[1].Platform.ID != "jetstream" {
		t.Fatalf("dynamic platform moved incorrectly: %+v", state.Platforms)
	}
	state.Platforms[1].Platform.DisplayName = "mutated"
	if stub.state.Platforms[0].Platform.DisplayName != "Jetstream" {
		t.Fatal("static peer Current() exposed a mutable upstream alias")
	}
}

func TestStaticPeersDecorateSubscriptions(t *testing.T) {
	now := time.Date(2026, time.August, 30, 20, 5, 0, 0, time.UTC)
	stub := &peerStubSource{ch: make(chan Snapshot, 1)}
	peers, err := NewStaticPeers(stub, []Platform{{
		ID: "nidhogg", DisplayName: "Nidhogg", Kind: PlatformKindHost, DashboardURL: "https://nidhogg.example.test/",
	}})
	if err != nil {
		t.Fatalf("NewStaticPeers() error = %v", err)
	}
	updates, unsubscribe := peers.Subscribe()
	stub.ch <- Snapshot{SchemaVersion: SchemaVersion, Sequence: 2, ObservedAt: now, Platforms: make([]PlatformObservation, 0)}
	select {
	case state := <-updates:
		if state.Sequence != 2 || len(state.Platforms) != 1 || state.Platforms[0].Platform.ID != "nidhogg" {
			t.Fatalf("subscription state = %+v", state)
		}
	case <-time.After(time.Second):
		t.Fatal("static peer subscription timed out")
	}
	unsubscribe()
}

func TestStaticPeersRejectUnsafeOrNonHostEntries(t *testing.T) {
	stub := &peerStubSource{}
	for _, peer := range []Platform{
		{ID: "jetstream", DisplayName: "Jetstream", Kind: PlatformKindOpenStack, DashboardURL: "https://example.test/"},
		{ID: "nidhogg", DisplayName: "Nidhogg", Kind: PlatformKindHost},
		{ID: "nidhogg", DisplayName: "Nidhogg", Kind: PlatformKindHost, DashboardURL: "https://example.test/?token=secret"},
	} {
		if _, err := NewStaticPeers(stub, []Platform{peer}); err == nil {
			t.Errorf("NewStaticPeers(%+v) error = nil, want rejection", peer)
		}
	}
}
