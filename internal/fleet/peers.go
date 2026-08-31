package fleet

import (
	"errors"
	"sync"
)

// StateSource is the read-only state contract shared by the fleet API and
// source decorators.
type StateSource interface {
	Current() (Snapshot, bool)
	Subscribe() (<-chan Snapshot, func())
}

// UplinkAuthorizationSource exposes the controller's atomically published,
// current-inventory eligibility index without cloning the public snapshot.
type UplinkAuthorizationSource interface {
	UplinkAuthorized(creatorID, instanceUUID string) bool
}

// StaticPeers adds configured direct-dashboard platforms, such as Nidhogg, to
// a dynamic fleet source without changing the single-host service itself.
type StaticPeers struct {
	source StateSource
	peers  []Platform
}

func NewStaticPeers(source StateSource, peers []Platform) (*StaticPeers, error) {
	if source == nil {
		return nil, errors.New("static fleet peers require a state source")
	}
	validated := make([]Platform, len(peers))
	seen := make(map[string]struct{}, len(peers))
	for index, peer := range peers {
		if err := validatePlatform(peer); err != nil {
			return nil, err
		}
		if peer.Kind != PlatformKindHost || peer.DashboardURL == "" {
			return nil, errors.New("static fleet peers must be HTTPS host dashboards")
		}
		if _, duplicate := seen[peer.ID]; duplicate {
			return nil, errors.New("static fleet peer IDs must be unique")
		}
		seen[peer.ID] = struct{}{}
		validated[index] = peer
	}
	return &StaticPeers{source: source, peers: validated}, nil
}

func (source *StaticPeers) Current() (Snapshot, bool) {
	state, ok := source.source.Current()
	if !ok {
		return Snapshot{}, false
	}
	return source.decorate(state), true
}

func (source *StaticPeers) UplinkAuthorized(creatorID, instanceUUID string) bool {
	authorizer, ok := source.source.(UplinkAuthorizationSource)
	return ok && authorizer.UplinkAuthorized(creatorID, instanceUUID)
}

func (source *StaticPeers) Subscribe() (<-chan Snapshot, func()) {
	upstream, unsubscribeUpstream := source.source.Subscribe()
	updates := make(chan Snapshot, 1)
	done := make(chan struct{})
	go func() {
		defer close(updates)
		for {
			select {
			case <-done:
				return
			case state, open := <-upstream:
				if !open {
					return
				}
				decorated := source.decorate(state)
				select {
				case updates <- decorated:
				default:
					select {
					case <-updates:
					default:
					}
					select {
					case updates <- decorated:
					default:
					}
				}
			}
		}
	}()
	var once sync.Once
	return updates, func() {
		once.Do(func() {
			close(done)
			unsubscribeUpstream()
		})
	}
}

func (source *StaticPeers) decorate(input Snapshot) Snapshot {
	state := cloneSnapshot(input)
	platforms := make([]PlatformObservation, 0, len(source.peers)+len(state.Platforms))
	for _, peer := range source.peers {
		observedAt := state.ObservedAt
		platforms = append(platforms, PlatformObservation{
			Platform: peer,
			Inventory: InventoryHealth{
				Status:        InventoryAvailable,
				ObservedAt:    timePointer(observedAt),
				LastAttemptAt: observedAt,
				LastSuccessAt: timePointer(observedAt),
			},
			Instances: make([]InstanceObservation, 0),
		})
	}
	platforms = append(platforms, state.Platforms...)
	state.Platforms = platforms
	return state
}
