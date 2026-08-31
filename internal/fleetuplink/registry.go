// Package fleetuplink stores the latest authenticated, agent-pushed telemetry
// for the fleet controller. It contains no HTTP or authentication policy: the
// caller must authenticate the request and pass the resulting project and
// instance identities explicitly.
package fleetuplink

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/intellisys-stevens/miglens/internal/fleet"
)

const (
	DefaultTTL                 = 2 * time.Minute
	DefaultMaxSampleAge        = 2 * time.Minute
	DefaultMaxFutureSkew       = 30 * time.Second
	DefaultMaxBodyBytes        = int64(8 << 20)
	DefaultMaxEntries          = 10_000
	DefaultMaxRetainedBytes    = int64(256 << 20)
	DefaultMaxCreatorBytes     = int64(64 << 20)
	MaximumMaxRetainedBytes    = int64(1 << 30)
	MaximumMaxCreatorBytes     = int64(256 << 20)
	DefaultMaxFieldBytes       = 64 << 10
	DefaultMaxGPUs             = 64
	DefaultMaxGPUInstances     = 1_024
	DefaultMaxComputeInstances = 4_096
	DefaultMaxProcesses        = 32_768
	DefaultMaxDiagnostics      = 4_096
	DefaultMaxMetrics          = 32_768
	DefaultMaxWorkloads        = 4_096
	DefaultMaxAssignments      = 8_192
)

var (
	ErrInvalidConfig      = errors.New("fleet uplink registry configuration is invalid")
	ErrInvalidIdentity    = errors.New("fleet uplink identity is invalid")
	ErrInvalidBodySize    = errors.New("fleet uplink body size is invalid")
	ErrBodyTooLarge       = errors.New("fleet uplink body exceeds the configured limit")
	ErrInvalidSample      = errors.New("fleet uplink sample is invalid")
	ErrIncompatibleSchema = errors.New("fleet uplink snapshot schema is incompatible")
	ErrSampleTooOld       = errors.New("fleet uplink sample is too old")
	ErrSampleInFuture     = errors.New("fleet uplink sample is too far in the future")
	ErrReplay             = errors.New("fleet uplink sample is not newer than the stored sample")
	ErrCapacity           = errors.New("fleet uplink registry is at capacity")
)

// Config defines hard acceptance and retention limits. Zero values select the
// package defaults. Negative values are rejected rather than interpreted as an
// unlimited setting.
type Config struct {
	// TTL is the maximum receipt retention and must be at least MaxSampleAge.
	TTL           time.Duration
	MaxSampleAge  time.Duration
	MaxFutureSkew time.Duration

	MaxBodyBytes int64
	MaxEntries   int
	// MaxRetainedBytes and MaxCreatorBytes account admitted request-body bytes
	// as a conservative, deterministic proxy for retained heap use. Both are
	// hard ceilings; replacing an entry releases its prior accounting first.
	MaxRetainedBytes int64
	MaxCreatorBytes  int64
	MaxFieldBytes    int

	// Collection limits are totals across a single sample, including nested
	// objects. For example, MaxDiagnostics covers both top-level and compute
	// instance diagnostics.
	MaxGPUs             int
	MaxGPUInstances     int
	MaxComputeInstances int
	MaxProcesses        int
	MaxDiagnostics      int
	MaxMetrics          int
	MaxWorkloads        int
	MaxAssignments      int
}

type registryKey struct {
	projectID    string
	instanceUUID string
}

type registryEntry struct {
	sample    fleet.AgentSample
	creatorID string
	bodyBytes int64
	expiresAt time.Time
}

type replayWatermark struct {
	sampledAt time.Time
	expiresAt time.Time
}

type creatorKey struct {
	projectID string
	creatorID string
}

// Registry is a concurrency-safe, bounded latest-state store. It is safe for
// simultaneous Put, Get, Delete, and Prune calls.
type Registry struct {
	mu                   sync.Mutex
	config               Config
	entries              map[registryKey]registryEntry
	watermarks           map[registryKey]replayWatermark
	retainedBytes        int64
	creatorRetainedBytes map[creatorKey]int64
}

var openStackUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// New constructs an empty registry with normalized, finite limits.
func New(config Config) (*Registry, error) {
	normalized, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	return &Registry{
		config:               normalized,
		entries:              make(map[registryKey]registryEntry),
		watermarks:           make(map[registryKey]replayWatermark),
		creatorRetainedBytes: make(map[creatorKey]int64),
	}, nil
}

// Put validates and stores sample as the latest state for the authenticated
// project/instance pair. bodyBytes must be the actual number of request-body
// bytes admitted by the transport layer.
//
// Payload identity is never authoritative. InstanceUUID, ObservedAt, and Source
// are overwritten from the authenticated key and validated snapshot. Hostname
// remains display telemetry and is never used for lookup or authorization.
func (r *Registry) Put(projectID, instanceUUID string, bodyBytes int64, sample fleet.AgentSample, now time.Time) error {
	if r == nil {
		return fmt.Errorf("%w: registry is nil", ErrInvalidConfig)
	}
	key, err := makeKey(projectID, instanceUUID)
	if err != nil {
		return err
	}
	if bodyBytes <= 0 {
		return ErrInvalidBodySize
	}
	if bodyBytes > r.config.MaxBodyBytes {
		return ErrBodyTooLarge
	}
	if now.IsZero() {
		return fmt.Errorf("%w: receipt time is required", ErrInvalidSample)
	}
	now = now.UTC()
	if !validOpaqueIdentifier(sample.CreatorID, 256) || strings.ContainsAny(sample.CreatorID, "*?") {
		return ErrInvalidIdentity
	}

	// Validate the caller-owned value before allocating a second full object
	// graph. The retained clone is still created before the caller regains
	// control, so subsequent caller mutation cannot affect registry state.
	candidate := sample
	candidate.InstanceUUID = key.instanceUUID
	candidate.Source = fleet.TelemetrySourceMIGLensUplink
	candidate.Snapshot.SampledAt = candidate.Snapshot.SampledAt.UTC()
	candidate.ObservedAt = candidate.Snapshot.SampledAt
	if err := validateSample(candidate, now, r.config); err != nil {
		return err
	}
	stored := cloneAgentSample(candidate)

	r.mu.Lock()
	defer r.mu.Unlock()
	// The common path touches only the claimed key. A full bounded scan is
	// deferred until admitting this request would otherwise exceed an entry or
	// byte budget, so a valid token cannot turn every Put into O(MaxEntries)
	// work.
	r.pruneKeyLocked(key, now)
	watermark, watermarkFound := r.watermarks[key]
	if watermarkFound {
		if !stored.Snapshot.SampledAt.After(watermark.sampledAt) {
			return ErrReplay
		}
	}
	if !r.hasAdmissionCapacityLocked(key, stored.CreatorID, bodyBytes) {
		r.pruneLocked(now)
		if !r.hasAdmissionCapacityLocked(key, stored.CreatorID, bodyBytes) {
			return ErrCapacity
		}
	}
	current, currentFound := r.entries[key]
	creator := creatorKey{projectID: key.projectID, creatorID: stored.CreatorID}
	expiresAt := now.Add(r.config.TTL)
	// A retained entry must satisfy both receipt TTL and sample freshness.
	// Otherwise a recently received but already-old full snapshot could mask a
	// newer, lower-fidelity console observation until the receipt TTL elapsed.
	if sampleExpiresAt := stored.Snapshot.SampledAt.Add(r.config.MaxSampleAge); sampleExpiresAt.Before(expiresAt) {
		expiresAt = sampleExpiresAt
	}
	if currentFound {
		r.removeEntryAccountingLocked(key, current)
	}
	if now.Before(expiresAt) {
		r.entries[key] = registryEntry{sample: stored, creatorID: stored.CreatorID, bodyBytes: bodyBytes, expiresAt: expiresAt}
		r.retainedBytes += bodyBytes
		r.creatorRetainedBytes[creator] += bodyBytes
	}
	// Payload retention and replay protection have different lifetimes. In
	// particular, a future-skewed sample can remain admissible after its receipt
	// TTL expires. Keep only this small watermark until the complete admission
	// window closes.
	r.watermarks[key] = replayWatermark{
		sampledAt: stored.Snapshot.SampledAt,
		expiresAt: stored.Snapshot.SampledAt.Add(r.config.MaxSampleAge),
	}
	return nil
}

// Get returns a deep clone of a retained sample that is still fresh. Effective
// expiry is the earlier of receipt TTL and sampledAt + MaxSampleAge. It is
// evaluated against the caller-supplied time to keep the registry deterministic.
// Expired entries are removed lazily.
func (r *Registry) Get(projectID, instanceUUID string, now time.Time) (fleet.AgentSample, bool) {
	if r == nil || now.IsZero() {
		return fleet.AgentSample{}, false
	}
	key, err := makeKey(projectID, instanceUUID)
	if err != nil {
		return fleet.AgentSample{}, false
	}
	now = now.UTC()
	r.mu.Lock()
	entry, found := r.entries[key]
	if !found {
		r.mu.Unlock()
		return fleet.AgentSample{}, false
	}
	if !now.Before(entry.expiresAt) {
		r.removeEntryAccountingLocked(key, entry)
		r.mu.Unlock()
		return fleet.AgentSample{}, false
	}
	sample := entry.sample
	r.mu.Unlock()
	return cloneAgentSample(sample), true
}

// Delete removes one exact retained payload. Its small replay watermark remains
// until the admission window closes, so operational cleanup cannot make an old
// request admissible again. It returns whether a payload was present.
func (r *Registry) Delete(projectID, instanceUUID string) bool {
	if r == nil {
		return false
	}
	key, err := makeKey(projectID, instanceUUID)
	if err != nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, entryFound := r.entries[key]
	if !entryFound {
		return false
	}
	r.removeEntryAccountingLocked(key, entry)
	return true
}

// Prune deletes all entries whose effective retention deadline has elapsed and
// returns the number removed. A zero time is rejected as a no-op.
func (r *Registry) Prune(now time.Time) int {
	if r == nil || now.IsZero() {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.pruneLocked(now.UTC())
}

func (r *Registry) pruneLocked(now time.Time) int {
	removed := 0
	for key, entry := range r.entries {
		if !now.Before(entry.expiresAt) {
			r.removeEntryAccountingLocked(key, entry)
			removed++
		}
	}
	for key, watermark := range r.watermarks {
		// At the exact freshness boundary validateSample still admits a sample.
		// Retain the watermark through that instant so equality remains a replay.
		if now.After(watermark.expiresAt) {
			delete(r.watermarks, key)
		}
	}
	return removed
}

func (r *Registry) pruneKeyLocked(key registryKey, now time.Time) {
	if entry, found := r.entries[key]; found && !now.Before(entry.expiresAt) {
		r.removeEntryAccountingLocked(key, entry)
	}
	if watermark, found := r.watermarks[key]; found && now.After(watermark.expiresAt) {
		delete(r.watermarks, key)
	}
}

func (r *Registry) hasAdmissionCapacityLocked(key registryKey, creatorID string, bodyBytes int64) bool {
	if _, found := r.watermarks[key]; !found && len(r.watermarks) >= r.config.MaxEntries {
		return false
	}
	current, currentFound := r.entries[key]
	baseRetained := r.retainedBytes
	creator := creatorKey{projectID: key.projectID, creatorID: creatorID}
	baseCreatorRetained := r.creatorRetainedBytes[creator]
	if currentFound {
		baseRetained -= current.bodyBytes
		if current.creatorID == creatorID {
			baseCreatorRetained -= current.bodyBytes
		}
	}
	return bodyBytes <= r.config.MaxRetainedBytes-baseRetained && bodyBytes <= r.config.MaxCreatorBytes-baseCreatorRetained
}

func (r *Registry) removeEntryAccountingLocked(key registryKey, entry registryEntry) {
	delete(r.entries, key)
	r.retainedBytes -= entry.bodyBytes
	creator := creatorKey{projectID: key.projectID, creatorID: entry.creatorID}
	remaining := r.creatorRetainedBytes[creator] - entry.bodyBytes
	if remaining <= 0 {
		delete(r.creatorRetainedBytes, creator)
	} else {
		r.creatorRetainedBytes[creator] = remaining
	}
}

func makeKey(projectID, instanceUUID string) (registryKey, error) {
	if !validOpaqueIdentifier(projectID, 256) || !openStackUUID.MatchString(instanceUUID) {
		return registryKey{}, ErrInvalidIdentity
	}
	return registryKey{projectID: projectID, instanceUUID: instanceUUID}, nil
}

func validOpaqueIdentifier(value string, maxBytes int) bool {
	if value == "" || len(value) > maxBytes || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func normalizeConfig(config Config) (Config, error) {
	if config.TTL < 0 || config.MaxSampleAge < 0 || config.MaxFutureSkew < 0 ||
		config.MaxBodyBytes < 0 || config.MaxEntries < 0 || config.MaxRetainedBytes < 0 || config.MaxCreatorBytes < 0 || config.MaxFieldBytes < 0 ||
		config.MaxGPUs < 0 || config.MaxGPUInstances < 0 || config.MaxComputeInstances < 0 ||
		config.MaxProcesses < 0 || config.MaxDiagnostics < 0 || config.MaxMetrics < 0 ||
		config.MaxWorkloads < 0 || config.MaxAssignments < 0 {
		return Config{}, ErrInvalidConfig
	}
	if config.TTL == 0 {
		config.TTL = DefaultTTL
	}
	if config.MaxSampleAge == 0 {
		config.MaxSampleAge = DefaultMaxSampleAge
	}
	if config.MaxFutureSkew == 0 {
		config.MaxFutureSkew = DefaultMaxFutureSkew
	}
	if config.MaxBodyBytes == 0 {
		config.MaxBodyBytes = DefaultMaxBodyBytes
	}
	if config.MaxEntries == 0 {
		config.MaxEntries = DefaultMaxEntries
	}
	if config.MaxRetainedBytes == 0 {
		config.MaxRetainedBytes = DefaultMaxRetainedBytes
	}
	if config.MaxCreatorBytes == 0 {
		config.MaxCreatorBytes = DefaultMaxCreatorBytes
	}
	if config.MaxRetainedBytes > MaximumMaxRetainedBytes || config.MaxCreatorBytes > MaximumMaxCreatorBytes ||
		config.MaxBodyBytes > config.MaxCreatorBytes || config.MaxCreatorBytes > config.MaxRetainedBytes {
		return Config{}, ErrInvalidConfig
	}
	if config.MaxFieldBytes == 0 {
		config.MaxFieldBytes = DefaultMaxFieldBytes
	}
	if config.MaxGPUs == 0 {
		config.MaxGPUs = DefaultMaxGPUs
	}
	if config.MaxGPUInstances == 0 {
		config.MaxGPUInstances = DefaultMaxGPUInstances
	}
	if config.MaxComputeInstances == 0 {
		config.MaxComputeInstances = DefaultMaxComputeInstances
	}
	if config.MaxProcesses == 0 {
		config.MaxProcesses = DefaultMaxProcesses
	}
	if config.MaxDiagnostics == 0 {
		config.MaxDiagnostics = DefaultMaxDiagnostics
	}
	if config.MaxMetrics == 0 {
		config.MaxMetrics = DefaultMaxMetrics
	}
	if config.MaxWorkloads == 0 {
		config.MaxWorkloads = DefaultMaxWorkloads
	}
	if config.MaxAssignments == 0 {
		config.MaxAssignments = DefaultMaxAssignments
	}
	// Keep the conservative payload-retention invariant used by hub
	// configuration. Replay protection does not rely on this relationship: its
	// independent watermark survives through sampledAt + MaxSampleAge.
	if config.TTL < config.MaxSampleAge {
		return Config{}, ErrInvalidConfig
	}
	return config, nil
}
