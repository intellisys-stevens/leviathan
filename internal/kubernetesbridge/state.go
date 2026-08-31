package kubernetesbridge

import (
	"crypto/rand"
	"encoding/hex"
	"reflect"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/attribution"
	"github.com/intellisys-stevens/leviathan/internal/model"
)

type State struct {
	mu sync.RWMutex

	bridgeVersion string
	instanceID    string
	nodeRef       string
	revision      uint64
	observedAt    time.Time
	status        attribution.SourceStatus
	workloads     []model.WorkloadAttribution
	assignments   []model.ResourceAssignment
	processScopes []attribution.ProcessScope
	stats         BuildStats
}

func NewState(bridgeVersion, nodeName string, now time.Time) *State {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		stamp := now.UTC().Format(time.RFC3339Nano)
		return newStateWithInstance(bridgeVersion, nodeName, HashRef("instance_", stamp), now)
	}
	return newStateWithInstance(bridgeVersion, nodeName, "instance_"+hex.EncodeToString(random), now)
}

func newStateWithInstance(bridgeVersion, nodeName, instanceID string, now time.Time) *State {
	return &State{
		bridgeVersion: bridgeVersion, instanceID: instanceID, nodeRef: HashRef("node_", nodeName),
		revision: 1, observedAt: now.UTC(),
		status:    attribution.SourceStatus{State: attribution.SourceStale, HasValidInventory: false, Message: "Kubernetes attribution cache is synchronizing"},
		workloads: []model.WorkloadAttribution{}, assignments: []model.ResourceAssignment{}, processScopes: []attribution.ProcessScope{},
	}
}

func (s *State) Update(workloads []model.WorkloadAttribution, assignments []model.ResourceAssignment, processScopes []attribution.ProcessScope, stats BuildStats, observedAt time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	nextWorkloads := append([]model.WorkloadAttribution{}, workloads...)
	nextAssignments := append([]model.ResourceAssignment{}, assignments...)
	nextProcessScopes := append([]attribution.ProcessScope{}, processScopes...)
	changed := !reflect.DeepEqual(s.workloads, nextWorkloads) || !reflect.DeepEqual(s.assignments, nextAssignments) || !reflect.DeepEqual(s.processScopes, nextProcessScopes) || s.status.State != attribution.SourceAvailable
	s.workloads = nextWorkloads
	s.assignments = nextAssignments
	s.processScopes = nextProcessScopes
	s.stats = stats
	s.observedAt = observedAt.UTC()
	s.status = attribution.SourceStatus{State: attribution.SourceAvailable, HasValidInventory: true}
	if changed {
		s.revision++
	}
}

func (s *State) MarkUnavailable() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status.State == attribution.SourceStale && s.status.Message == "Kubernetes attribution source is unavailable" {
		return
	}
	s.status = attribution.SourceStatus{State: attribution.SourceStale, HasValidInventory: s.status.HasValidInventory, Message: "Kubernetes attribution source is unavailable"}
	s.revision++
}

func (s *State) Document(now time.Time) attribution.Document {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return attribution.Document{
		SchemaVersion: attribution.SchemaVersion, BridgeVersion: s.bridgeVersion,
		InstanceID: s.instanceID, Revision: s.revision, GeneratedAt: now.UTC(), SourceObservedAt: s.observedAt,
		NodeRef: s.nodeRef, Status: s.status,
		Workloads: append([]model.WorkloadAttribution{}, s.workloads...), Assignments: append([]model.ResourceAssignment{}, s.assignments...),
		ProcessScopes: append([]attribution.ProcessScope{}, s.processScopes...),
	}
}

func (s *State) Ready() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status.State == attribution.SourceAvailable
}

func (s *State) Stats() BuildStats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.stats
}
