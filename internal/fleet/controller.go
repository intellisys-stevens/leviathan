package fleet

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type InventorySource interface {
	List(context.Context) (InventoryObservation, error)
}

type AgentSource interface {
	// Observe may be called concurrently. Implementations must honor context
	// cancellation and should also configure transport-level timeouts.
	Observe(context.Context, Instance) (AgentSample, error)
}

type ControllerOptions struct {
	MaxConcurrentAgents int
	AgentStaleAfter     time.Duration
	AgentTimeout        time.Duration
	Clock               func() time.Time
}

type Controller struct {
	platform  Platform
	inventory InventorySource
	agents    AgentSource
	policy    Policy
	options   ControllerOptions

	refreshGate    chan struct{}
	agentSlots     chan struct{}
	stateMu        sync.Mutex
	current        Snapshot
	hasState       bool
	uplinkCreators map[string][sha256.Size]byte
	nextSubID      uint64
	subs           map[uint64]chan Snapshot
}

func NewController(platform Platform, inventory InventorySource, agents AgentSource, policy Policy, options ControllerOptions) (*Controller, error) {
	if err := validatePlatform(platform); err != nil {
		return nil, err
	}
	if inventory == nil {
		return nil, errors.New("fleet inventory source is required")
	}
	if agents == nil {
		return nil, errors.New("fleet agent source is required")
	}
	if platform.Kind != PlatformKindOpenStack {
		return nil, errors.New("fleet controller requires an OpenStack platform")
	}
	if options.MaxConcurrentAgents <= 0 {
		options.MaxConcurrentAgents = 8
	}
	if options.AgentStaleAfter <= 0 {
		options.AgentStaleAfter = 30 * time.Second
	}
	if options.AgentTimeout <= 0 {
		options.AgentTimeout = 10 * time.Second
	}
	if options.Clock == nil {
		options.Clock = func() time.Time { return time.Now().UTC() }
	}
	return &Controller{
		platform:       platform,
		inventory:      inventory,
		agents:         agents,
		policy:         policy,
		options:        options,
		refreshGate:    make(chan struct{}, 1),
		agentSlots:     make(chan struct{}, options.MaxConcurrentAgents),
		subs:           make(map[uint64]chan Snapshot),
		uplinkCreators: make(map[string][sha256.Size]byte),
	}, nil
}

func (c *Controller) Current() (Snapshot, bool) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return cloneSnapshot(c.current), c.hasState
}

// UplinkAuthorized performs one current-inventory lookup. The eligibility map
// is replaced in the same critical section that publishes Current(), so an
// authorization decision cannot lag behind a newer public controller state.
func (c *Controller) UplinkAuthorized(creatorID, instanceUUID string) bool {
	if c == nil {
		return false
	}
	creatorDigest := sha256.Sum256([]byte(creatorID))
	c.stateMu.Lock()
	expectedCreator, found := c.uplinkCreators[instanceUUID]
	c.stateMu.Unlock()
	return found && subtle.ConstantTimeCompare(creatorDigest[:], expectedCreator[:]) == 1
}

// Subscribe returns a size-one latest-state channel. A slow subscriber drops
// superseded states rather than delaying inventory or agent refreshes.
func (c *Controller) Subscribe() (<-chan Snapshot, func()) {
	c.stateMu.Lock()
	id := c.nextSubID
	c.nextSubID++
	channel := make(chan Snapshot, 1)
	c.subs[id] = channel
	if c.hasState {
		channel <- cloneSnapshot(c.current)
	}
	c.stateMu.Unlock()

	var once sync.Once
	return channel, func() {
		once.Do(func() {
			c.stateMu.Lock()
			if active, ok := c.subs[id]; ok {
				delete(c.subs, id)
				close(active)
			}
			c.stateMu.Unlock()
		})
	}
}

// Refresh serializes refresh cycles, while observing eligible agents in
// parallel inside each cycle. Cancellation never publishes a degraded state.
func (c *Controller) Refresh(ctx context.Context) Snapshot {
	select {
	case c.refreshGate <- struct{}{}:
		defer func() { <-c.refreshGate }()
	case <-ctx.Done():
		current, _ := c.Current()
		return current
	}
	if ctx.Err() != nil {
		current, _ := c.Current()
		return current
	}

	attemptedAt := c.options.Clock().UTC()
	previous, hadPrevious := c.Current()
	observation, err := c.inventory.List(ctx)
	if ctx.Err() != nil {
		return previous
	}
	if err != nil {
		completedAt := c.options.Clock().UTC()
		return c.store(c.inventoryFailure(attemptedAt, completedAt, previous, hadPrevious))
	}

	instances, err := validateAndSortInstances(observation.Instances)
	if err != nil {
		completedAt := c.options.Clock().UTC()
		return c.store(c.inventoryFailure(attemptedAt, completedAt, previous, hadPrevious))
	}
	previousByUUID := previousInstances(previous)
	results := make([]InstanceObservation, len(instances))
	var wait sync.WaitGroup

	for index, instance := range instances {
		decision := c.policy.Evaluate(instance)
		if decision.Allowlisted && decision.CreatorUsername != "" {
			// Replace advisory cloud metadata with the trusted label paired with
			// the authoritative Nova user_id in controller configuration.
			instance.CreatorUsername = decision.CreatorUsername
		}
		agentStatus := AgentNotManaged
		if decision.Reason == PolicyAgentNotConfigured {
			agentStatus = AgentNotConfigured
		}
		results[index] = InstanceObservation{
			Instance:           instance,
			Managed:            decision.Allowlisted,
			AgentProbeEligible: decision.AgentProbeEligible,
			PolicyReason:       decision.Reason,
			Agent:              AgentObservation{Status: agentStatus},
		}
		if !decision.AgentProbeEligible {
			continue
		}

		wait.Add(1)
		go func(index int, instance Instance) {
			defer wait.Done()
			agentAttemptedAt := c.options.Clock().UTC()
			sample, observeErr := c.observeAgent(ctx, instance)
			completedAt := c.options.Clock().UTC()
			if observeErr != nil {
				results[index].Agent = failedAgentObservation(agentAttemptedAt, previousByUUID[instance.UUID])
				return
			}
			results[index].Agent = c.successfulAgentObservation(agentAttemptedAt, completedAt, instance, sample)
		}(index, instance)
	}
	wait.Wait()
	if ctx.Err() != nil {
		return previous
	}
	completedAt := c.options.Clock().UTC()

	observedAt := observation.ObservedAt.UTC()
	if observation.ObservedAt.IsZero() {
		observedAt = completedAt
	}
	health := InventoryHealth{
		Status:        InventoryAvailable,
		ObservedAt:    timePointer(observedAt),
		LastAttemptAt: attemptedAt,
		LastSuccessAt: timePointer(completedAt),
	}
	state := Snapshot{
		SchemaVersion: SchemaVersion,
		ObservedAt:    completedAt,
		Platforms: []PlatformObservation{{
			Platform:  c.platform,
			Inventory: health,
			Instances: results,
		}},
	}
	return c.store(state)
}

func (c *Controller) successfulAgentObservation(attemptedAt, completedAt time.Time, instance Instance, sample AgentSample) AgentObservation {
	source := sample.Source
	if source == "" {
		// Existing AgentSource implementations predate the explicit transport
		// marker. Preserve their behavior while new sources identify themselves.
		source = TelemetrySourceLeviathanAgent
	}
	attempt := timePointer(attemptedAt)
	if sample.InstanceUUID != instance.UUID {
		return AgentObservation{
			Status:        AgentIncompatible,
			Source:        source,
			LastAttemptAt: attempt,
			Message:       "agent identity does not match inventory instance",
		}
	}
	if sample.Snapshot.SchemaVersion != "v1" {
		buildInfo := cloneBuildInfo(sample.BuildInfo)
		return AgentObservation{
			Status:        AgentIncompatible,
			Source:        source,
			LastAttemptAt: attempt,
			BuildInfo:     buildInfo,
			Message:       "agent snapshot schema is incompatible",
		}
	}
	observedAt := sample.ObservedAt.UTC()
	if sample.ObservedAt.IsZero() {
		observedAt = sample.Snapshot.SampledAt.UTC()
	}
	if observedAt.IsZero() {
		observedAt = completedAt
	}
	status := AgentAvailable
	message := ""
	if completedAt.Sub(observedAt) > c.options.AgentStaleAfter {
		status = AgentStale
		message = "agent telemetry is stale"
	}
	snapshot := sanitizedModelSnapshot(sample.Snapshot)
	return AgentObservation{
		Status:        status,
		Source:        source,
		LastAttemptAt: attempt,
		LastSuccessAt: timePointer(completedAt),
		ObservedAt:    timePointer(observedAt),
		BuildInfo:     cloneBuildInfo(sample.BuildInfo),
		Snapshot:      &snapshot,
		Message:       message,
	}
}

func failedAgentObservation(now time.Time, previous InstanceObservation) AgentObservation {
	if previous.Agent.Snapshot != nil {
		cached := previous.Agent
		cached.Status = AgentStale
		cached.LastAttemptAt = timePointer(now)
		cached.Message = "agent telemetry refresh failed"
		return cached
	}
	return AgentObservation{
		Status:        AgentUnreachable,
		LastAttemptAt: timePointer(now),
		Message:       "agent telemetry unavailable",
	}
}

func (c *Controller) inventoryFailure(attemptedAt, completedAt time.Time, previous Snapshot, hadPrevious bool) Snapshot {
	status := InventoryUnavailable
	instances := make([]InstanceObservation, 0)
	var observedAt *time.Time
	var lastSuccess *time.Time
	if hadPrevious && len(previous.Platforms) > 0 && previous.Platforms[0].Inventory.LastSuccessAt != nil {
		status = InventoryStale
		previousPlatform := previous.Platforms[0]
		instances = make([]InstanceObservation, len(previousPlatform.Instances))
		copy(instances, previousPlatform.Instances)
		for index := range instances {
			if instances[index].Agent.Status == AgentAvailable {
				instances[index].Agent.Status = AgentStale
				instances[index].Agent.Message = "inventory refresh failed"
			}
		}
		observedAt = previousPlatform.Inventory.ObservedAt
		lastSuccess = previousPlatform.Inventory.LastSuccessAt
	}
	return Snapshot{
		SchemaVersion: SchemaVersion,
		ObservedAt:    completedAt,
		Platforms: []PlatformObservation{{
			Platform: c.platform,
			Inventory: InventoryHealth{
				Status:        status,
				ObservedAt:    observedAt,
				LastAttemptAt: attemptedAt,
				LastSuccessAt: lastSuccess,
				Message:       "inventory refresh failed",
			},
			Instances: instances,
		}},
	}
}

func (c *Controller) store(state Snapshot) Snapshot {
	uplinkCreators := make(map[string][sha256.Size]byte)
	for _, platform := range state.Platforms {
		if platform.Platform.Kind != PlatformKindOpenStack || platform.Inventory.Status != InventoryAvailable {
			continue
		}
		for _, observation := range platform.Instances {
			if observation.Instance.CloudState == CloudStateActive && observation.Managed && observation.AgentProbeEligible {
				uplinkCreators[observation.Instance.UUID] = sha256.Sum256([]byte(observation.Instance.CreatorID))
			}
		}
	}
	c.stateMu.Lock()
	c.uplinkCreators = uplinkCreators
	state.Sequence = c.current.Sequence + 1
	owned := cloneSnapshot(state)
	c.current = owned
	c.hasState = true
	for _, subscriber := range c.subs {
		update := cloneSnapshot(owned)
		select {
		case subscriber <- update:
		default:
			select {
			case <-subscriber:
			default:
			}
			select {
			case subscriber <- update:
			default:
			}
		}
	}
	c.stateMu.Unlock()
	return cloneSnapshot(owned)
}

func validateAndSortInstances(instances []Instance) ([]Instance, error) {
	byUUID := make(map[string]Instance, len(instances))
	for _, instance := range instances {
		if !openStackUUID.MatchString(instance.UUID) {
			return nil, errors.New("inventory contains an invalid instance UUID")
		}
		if _, exists := byUUID[instance.UUID]; exists {
			return nil, errors.New("inventory contains a duplicate instance UUID")
		}
		byUUID[instance.UUID] = instance
	}
	result := make([]Instance, 0, len(byUUID))
	for _, instance := range byUUID {
		result = append(result, instance)
	}
	sort.Slice(result, func(left, right int) bool {
		leftName := strings.ToLower(result[left].Name)
		rightName := strings.ToLower(result[right].Name)
		if leftName == rightName {
			return result[left].UUID < result[right].UUID
		}
		return leftName < rightName
	})
	return result, nil
}

func previousInstances(snapshot Snapshot) map[string]InstanceObservation {
	result := make(map[string]InstanceObservation)
	for _, platform := range snapshot.Platforms {
		for _, instance := range platform.Instances {
			result[instance.Instance.UUID] = instance
		}
	}
	return result
}

func timePointer(value time.Time) *time.Time {
	copy := value
	return &copy
}

type agentResult struct {
	sample AgentSample
	err    error
}

func (c *Controller) observeAgent(parent context.Context, instance Instance) (AgentSample, error) {
	ctx, cancel := context.WithTimeout(parent, c.options.AgentTimeout)
	defer cancel()
	select {
	case c.agentSlots <- struct{}{}:
	case <-ctx.Done():
		return AgentSample{}, ctx.Err()
	}
	result := make(chan agentResult, 1)
	go func() {
		defer func() { <-c.agentSlots }()
		sample, err := c.agents.Observe(ctx, instance)
		result <- agentResult{sample: sample, err: err}
	}()
	select {
	case observed := <-result:
		return observed.sample, observed.err
	case <-ctx.Done():
		return AgentSample{}, ctx.Err()
	}
}

var platformID = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

func validatePlatform(platform Platform) error {
	if !platformID.MatchString(platform.ID) {
		return errors.New("fleet platform ID must be a lowercase stable identifier")
	}
	if platform.DisplayName == "" || strings.TrimSpace(platform.DisplayName) != platform.DisplayName || len(platform.DisplayName) > 128 {
		return errors.New("fleet platform display name must be a bounded non-empty value")
	}
	if platform.Kind != PlatformKindHost && platform.Kind != PlatformKindOpenStack {
		return errors.New("fleet platform kind is unsupported")
	}
	if platform.DashboardURL == "" {
		return nil
	}
	parsed, err := url.Parse(platform.DashboardURL)
	if err != nil || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" || strings.Contains(platform.DashboardURL, `\`) {
		return errors.New("fleet platform dashboard URL is invalid")
	}
	if parsed.IsAbs() {
		if parsed.Scheme != "https" || parsed.Hostname() == "" {
			return errors.New("fleet platform dashboard URL must use HTTPS")
		}
		return nil
	}
	if !strings.HasPrefix(parsed.Path, "/") || strings.HasPrefix(parsed.Path, "//") || parsed.Host != "" {
		return fmt.Errorf("fleet platform dashboard URL must be HTTPS or an absolute path")
	}
	return nil
}
