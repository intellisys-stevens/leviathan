package fleetuplink

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/fleet"
	"github.com/intellisys-stevens/leviathan/internal/model"
	"github.com/intellisys-stevens/leviathan/internal/provider/fake"
)

const (
	testProjectID    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testOtherProject = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testCreatorID    = "nova-user-a"
	testInstanceUUID = "11111111-1111-4111-8111-111111111111"
	testOtherUUID    = "22222222-2222-4222-8222-222222222222"
)

func TestRegistryPutGetCanonicalizesIdentityAndClones(t *testing.T) {
	now := testNow()
	registry := mustRegistry(t, Config{})
	sample := validSample(now.Add(-time.Second))
	sample.InstanceUUID = testOtherUUID
	sample.Source = fleet.TelemetrySourceLeviathanAgent
	sample.ObservedAt = now.Add(24 * time.Hour)

	if err := registry.Put(testProjectID, testInstanceUUID, 1024, sample, now); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	// Mutating every reference-bearing input shape after Put must not affect the
	// retained sample.
	sample.BuildInfo.Version = "mutated"
	sample.Snapshot.Host.Hostname = "mutated-host"
	*sample.Snapshot.GPUs[0].Memory.TotalBytes = 999
	metric := sample.Snapshot.GPUs[0].Metrics["gpu_util"]
	*metric.Value = 999
	sample.Snapshot.GPUs[0].Metrics["gpu_util"] = metric
	sample.Snapshot.GPUs[0].GPUInstances[0].ComputeInstances[0].Diagnostics[0].Summary = "mutated"
	*sample.Snapshot.Processes[0].StartTime = now
	sample.Snapshot.Attribution.Workloads[0].OwnerName = "mutated"
	sample.Snapshot.Diagnostics[0].Detail = "mutated"

	stored, ok := registry.Get(testProjectID, testInstanceUUID, now)
	if !ok {
		t.Fatal("Get() did not find stored sample")
	}
	if stored.InstanceUUID != testInstanceUUID {
		t.Fatalf("InstanceUUID = %q, want authenticated key", stored.InstanceUUID)
	}
	if stored.Source != fleet.TelemetrySourceLeviathanUplink {
		t.Fatalf("Source = %q, want %q", stored.Source, fleet.TelemetrySourceLeviathanUplink)
	}
	if !stored.ObservedAt.Equal(stored.Snapshot.SampledAt) {
		t.Fatalf("ObservedAt = %v, sampledAt = %v", stored.ObservedAt, stored.Snapshot.SampledAt)
	}
	if stored.BuildInfo.Version != "v0.2.0" || stored.Snapshot.Host.Hostname != "payload-host" {
		t.Fatalf("stored input was shared: build=%q host=%q", stored.BuildInfo.Version, stored.Snapshot.Host.Hostname)
	}
	if got := *stored.Snapshot.GPUs[0].Memory.TotalBytes; got != 80 {
		t.Fatalf("stored total memory = %d, want 80", got)
	}
	if got := *stored.Snapshot.GPUs[0].Metrics["gpu_util"].Value; got != 42 {
		t.Fatalf("stored metric = %v, want 42", got)
	}
	if got := stored.Snapshot.GPUs[0].GPUInstances[0].ComputeInstances[0].Diagnostics[0].Summary; got != "compute healthy" {
		t.Fatalf("stored nested diagnostic = %q", got)
	}
	if got := stored.Snapshot.Attribution.Workloads[0].OwnerName; got != "owner" {
		t.Fatalf("stored attribution owner = %q", got)
	}

	// Get must also return a deep clone rather than a view of registry memory.
	stored.BuildInfo.Version = "get-mutated"
	metric = stored.Snapshot.GPUs[0].Metrics["gpu_util"]
	*metric.Value = 123
	stored.Snapshot.GPUs[0].Metrics["gpu_util"] = metric
	stored.Snapshot.Processes[0].User = "get-mutated"
	stored.Snapshot.Attribution.Assignments[0].EntityUUID = "get-mutated"
	again, ok := registry.Get(testProjectID, testInstanceUUID, now)
	if !ok {
		t.Fatal("second Get() did not find stored sample")
	}
	if again.BuildInfo.Version != "v0.2.0" || *again.Snapshot.GPUs[0].Metrics["gpu_util"].Value != 42 || again.Snapshot.Processes[0].User != "gpu-user" {
		t.Fatal("Get() result shares mutable state with registry")
	}
	if _, ok := registry.Get(testOtherProject, testInstanceUUID, now); ok {
		t.Fatal("same instance UUID in a different project unexpectedly matched")
	}
	if _, ok := registry.Get(testProjectID, testOtherUUID, now); ok {
		t.Fatal("payload instance UUID unexpectedly became a lookup key")
	}
}

func TestRegistryRejectsReplayAndPreservesLatest(t *testing.T) {
	now := testNow()
	registry := mustRegistry(t, Config{})
	initial := validSample(now.Add(-3 * time.Second))
	initial.Snapshot.Sequence = 10
	if err := registry.Put(testProjectID, testInstanceUUID, 100, initial, now); err != nil {
		t.Fatalf("initial Put() error = %v", err)
	}

	replay := validSample(initial.Snapshot.SampledAt)
	replay.Snapshot.Sequence = 999
	replay.BuildInfo.Version = "replay"
	if err := registry.Put(testProjectID, testInstanceUUID, 100, replay, now); !errors.Is(err, ErrReplay) {
		t.Fatalf("equal sampledAt error = %v, want ErrReplay", err)
	}
	older := validSample(initial.Snapshot.SampledAt.Add(-time.Nanosecond))
	if err := registry.Put(testProjectID, testInstanceUUID, 100, older, now); !errors.Is(err, ErrReplay) {
		t.Fatalf("older sampledAt error = %v, want ErrReplay", err)
	}

	stored, ok := registry.Get(testProjectID, testInstanceUUID, now)
	if !ok || stored.Snapshot.Sequence != 10 || stored.BuildInfo.Version != "v0.2.0" {
		t.Fatalf("replay replaced latest sample: ok=%v sequence=%d build=%q", ok, stored.Snapshot.Sequence, stored.BuildInfo.Version)
	}
	newer := validSample(now.Add(-time.Second))
	newer.Snapshot.Sequence = 1 // sampledAt, not an agent-local sequence, is monotonic authority.
	if err := registry.Put(testProjectID, testInstanceUUID, 100, newer, now); err != nil {
		t.Fatalf("newer Put() error = %v", err)
	}
	stored, ok = registry.Get(testProjectID, testInstanceUUID, now)
	if !ok || stored.Snapshot.Sequence != 1 {
		t.Fatalf("newer sample was not stored: ok=%v sequence=%d", ok, stored.Snapshot.Sequence)
	}
}

func TestRegistryEnforcesFreshnessWindow(t *testing.T) {
	now := testNow()
	config := Config{MaxSampleAge: 10 * time.Second, MaxFutureSkew: 5 * time.Second}
	tests := []struct {
		name    string
		at      time.Time
		wantErr error
	}{
		{name: "old boundary accepted", at: now.Add(-10 * time.Second)},
		{name: "too old", at: now.Add(-10*time.Second - time.Nanosecond), wantErr: ErrSampleTooOld},
		{name: "future boundary accepted", at: now.Add(5 * time.Second)},
		{name: "too far in future", at: now.Add(5*time.Second + time.Nanosecond), wantErr: ErrSampleInFuture},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry := mustRegistry(t, config)
			err := registry.Put(testProjectID, testInstanceUUID, 100, validSample(test.at), now)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("Put() error = %v, want %v", err, test.wantErr)
			}
		})
	}
}

func TestRegistryRejectsInvalidSchemaAndBoundedFields(t *testing.T) {
	now := testNow()
	tests := []struct {
		name    string
		config  Config
		mutate  func(*fleet.AgentSample)
		wantErr error
	}{
		{name: "schema", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.SchemaVersion = "v2" }, wantErr: ErrIncompatibleSchema},
		{name: "zero sampledAt", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.SampledAt = time.Time{} }, wantErr: ErrInvalidSample},
		{name: "nil GPUs", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs = nil }, wantErr: ErrInvalidSample},
		{name: "nil processes", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Processes = nil }, wantErr: ErrInvalidSample},
		{name: "nil diagnostics", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Diagnostics = nil }, wantErr: ErrInvalidSample},
		{name: "nil GPU metrics", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].Metrics = nil }, wantErr: ErrInvalidSample},
		{name: "nil GPU instances", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].GPUInstances = nil }, wantErr: ErrInvalidSample},
		{name: "nil GPU instance metrics", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].GPUInstances[0].Metrics = nil }, wantErr: ErrInvalidSample},
		{name: "nil compute instances", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].GPUInstances[0].ComputeInstances = nil }, wantErr: ErrInvalidSample},
		{name: "nil compute metrics", mutate: func(sample *fleet.AgentSample) {
			sample.Snapshot.GPUs[0].GPUInstances[0].ComputeInstances[0].Metrics = nil
		}, wantErr: ErrInvalidSample},
		{name: "nil attribution workloads", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Attribution.Workloads = nil }, wantErr: ErrInvalidSample},
		{name: "nil attribution assignments", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Attribution.Assignments = nil }, wantErr: ErrInvalidSample},
		{name: "field bytes", config: Config{MaxFieldBytes: 16}, mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Host.Hostname = strings.Repeat("h", 17) }, wantErr: ErrInvalidSample},
		{name: "GPU count", config: Config{MaxGPUs: 1}, mutate: func(sample *fleet.AgentSample) {
			sample.Snapshot.GPUs = append(sample.Snapshot.GPUs, sample.Snapshot.GPUs[0])
		}, wantErr: ErrInvalidSample},
		{name: "metric count", config: Config{MaxMetrics: 1}, mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].Metrics["second"] = model.Metric{} }, wantErr: ErrInvalidSample},
		{name: "non-finite metric", mutate: func(sample *fleet.AgentSample) {
			sample.Snapshot.GPUs[0].Metrics["bad"] = model.Metric{Value: model.Float(math.Inf(1))}
		}, wantErr: ErrInvalidSample},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry := mustRegistry(t, test.config)
			sample := validSample(now.Add(-time.Second))
			test.mutate(&sample)
			err := registry.Put(testProjectID, testInstanceUUID, 100, sample, now)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("Put() error = %v, want %v", err, test.wantErr)
			}
		})
	}
}

func TestRegistryRejectsUnknownPublicContractEnums(t *testing.T) {
	now := testNow()
	tests := []struct {
		name   string
		mutate func(*fleet.AgentSample)
	}{
		{name: "metric status", mutate: func(sample *fleet.AgentSample) {
			updateFirstMetric(sample, func(metric *model.Metric) { metric.Status = "unknown" })
		}},
		{name: "metric source", mutate: func(sample *fleet.AgentSample) {
			updateFirstMetric(sample, func(metric *model.Metric) { metric.Source = "unknown" })
		}},
		{name: "metric scope", mutate: func(sample *fleet.AgentSample) {
			updateFirstMetric(sample, func(metric *model.Metric) { metric.Scope = "unknown" })
		}},
		{name: "memory status", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].Memory.Status = "unknown" }},
		{name: "memory source", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].Memory.Source = "unknown" }},
		{name: "memory scope", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].Memory.Scope = "unknown" }},
		{name: "provider status", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Capabilities.NVML.Status = "unknown" }},
		{name: "process status", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Processes[0].Status = "unknown" }},
		{name: "diagnostic status", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Diagnostics[0].Status = "unknown" }},
		{name: "diagnostic severity", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Diagnostics[0].Severity = "critical" }},
		{name: "attribution provider", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Attribution.Provider = "unknown" }},
		{name: "attribution status", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Attribution.Status = "unknown" }},
		{name: "workload platform", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Attribution.Workloads[0].Platform = "unknown" }},
		{name: "workload kind", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Attribution.Workloads[0].Kind = "unknown" }},
		{name: "assignment entity type", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Attribution.Assignments[0].EntityType = "unknown" }},
		{name: "assignment state", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Attribution.Assignments[0].State = "unknown" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry := mustRegistry(t, Config{})
			sample := validSample(now.Add(-time.Second))
			test.mutate(&sample)
			if err := registry.Put(testProjectID, testInstanceUUID, 100, sample, now); !errors.Is(err, ErrInvalidSample) {
				t.Fatalf("Put() error = %v, want ErrInvalidSample", err)
			}
		})
	}
}

func TestRegistryRejectsContradictoryValuesAndTimes(t *testing.T) {
	now := testNow()
	tests := []struct {
		name   string
		mutate func(*fleet.AgentSample)
	}{
		{name: "available metric without value", mutate: func(sample *fleet.AgentSample) {
			updateFirstMetric(sample, func(metric *model.Metric) { metric.Value = nil })
		}},
		{name: "unavailable metric with value", mutate: func(sample *fleet.AgentSample) {
			updateFirstMetric(sample, func(metric *model.Metric) { metric.Status = model.StatusStale })
		}},
		{name: "metric zero sampledAt", mutate: func(sample *fleet.AgentSample) {
			updateFirstMetric(sample, func(metric *model.Metric) { metric.SampledAt = time.Time{} })
		}},
		{name: "metric beyond future skew", mutate: func(sample *fleet.AgentSample) {
			updateFirstMetric(sample, func(metric *model.Metric) { metric.SampledAt = now.Add(DefaultMaxFutureSkew + time.Nanosecond) })
		}},
		{name: "available memory without total", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].Memory.TotalBytes = nil }},
		{name: "available memory without used", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].Memory.UsedBytes = nil }},
		{name: "available memory without free", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].Memory.FreeBytes = nil }},
		{name: "unavailable memory with usage", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].Memory.Status = model.StatusStale }},
		{name: "memory zero sampledAt", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].Memory.SampledAt = time.Time{} }},
		{name: "memory beyond future skew", mutate: func(sample *fleet.AgentSample) {
			sample.Snapshot.GPUs[0].Memory.SampledAt = now.Add(DefaultMaxFutureSkew + time.Nanosecond)
		}},
		{name: "memory used exceeds total", mutate: func(sample *fleet.AgentSample) {
			value := uint64(81)
			sample.Snapshot.GPUs[0].Memory.UsedBytes = &value
		}},
		{name: "memory free exceeds total", mutate: func(sample *fleet.AgentSample) {
			value := uint64(81)
			sample.Snapshot.GPUs[0].Memory.FreeBytes = &value
		}},
		{name: "available provider marked unavailable", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Capabilities.NVML.Available = false }},
		{name: "unavailable provider marked available", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Capabilities.GPM.Available = true }},
		{name: "process zero startTime", mutate: func(sample *fleet.AgentSample) { value := time.Time{}; sample.Snapshot.Processes[0].StartTime = &value }},
		{name: "process startTime beyond future skew", mutate: func(sample *fleet.AgentSample) {
			value := now.Add(DefaultMaxFutureSkew + time.Nanosecond)
			sample.Snapshot.Processes[0].StartTime = &value
		}},
		{name: "available attribution without observedAt", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.Attribution.ObservedAt = nil }},
		{name: "attribution zero observedAt", mutate: func(sample *fleet.AgentSample) { value := time.Time{}; sample.Snapshot.Attribution.ObservedAt = &value }},
		{name: "attribution observedAt beyond future skew", mutate: func(sample *fleet.AgentSample) {
			value := now.Add(DefaultMaxFutureSkew + time.Nanosecond)
			sample.Snapshot.Attribution.ObservedAt = &value
		}},
		{name: "unavailable attribution retains inventory", mutate: func(sample *fleet.AgentSample) {
			sample.Snapshot.Attribution.Status = model.AttributionUnavailable
			sample.Snapshot.Attribution.ObservedAt = nil
		}},
		{name: "negative GPU index", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].Index = -1 }},
		{name: "negative max MIG devices", mutate: func(sample *fleet.AgentSample) { sample.Snapshot.GPUs[0].MaxMIGDevices = -1 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry := mustRegistry(t, Config{})
			sample := validSample(now.Add(-time.Second))
			test.mutate(&sample)
			if err := registry.Put(testProjectID, testInstanceUUID, 100, sample, now); !errors.Is(err, ErrInvalidSample) {
				t.Fatalf("Put() error = %v, want ErrInvalidSample", err)
			}
		})
	}
}

func TestRegistryAcceptsCurrentLeviathanFixtureSnapshots(t *testing.T) {
	now := testNow()
	for _, fixtureName := range fake.Fixtures() {
		t.Run(fixtureName, func(t *testing.T) {
			provider, err := fake.NewFixture(fixtureName)
			if err != nil {
				t.Fatalf("NewFixture() error = %v", err)
			}
			snapshot, err := provider.Sample(context.Background(), now.Add(-time.Second))
			if err != nil {
				t.Fatalf("Sample() error = %v", err)
			}
			registry := mustRegistry(t, Config{})
			sample := fleet.AgentSample{CreatorID: testCreatorID, Snapshot: snapshot}
			if err := registry.Put(testProjectID, testInstanceUUID, 1, sample, now); err != nil {
				t.Fatalf("Put(real fixture snapshot) error = %v", err)
			}
		})
	}
}

func TestRegistryAcceptsUnavailableAndStaleAttributionShapes(t *testing.T) {
	now := testNow()
	for _, status := range []model.AttributionStatus{model.AttributionUnavailable, model.AttributionStale} {
		t.Run(string(status), func(t *testing.T) {
			registry := mustRegistry(t, Config{})
			sample := validSample(now.Add(-time.Second))
			sample.Snapshot.Attribution.Status = status
			if status == model.AttributionUnavailable {
				sample.Snapshot.Attribution.ObservedAt = nil
				sample.Snapshot.Attribution.Workloads = []model.WorkloadAttribution{}
				sample.Snapshot.Attribution.Assignments = []model.ResourceAssignment{}
			}
			if err := registry.Put(testProjectID, testInstanceUUID, 100, sample, now); err != nil {
				t.Fatalf("Put() error = %v", err)
			}
		})
	}
}

func TestRegistryBodyCapacityAndExpiredCapacityReuse(t *testing.T) {
	now := testNow()
	registry := mustRegistry(t, Config{MaxBodyBytes: 100, MaxEntries: 1, TTL: 10 * time.Second, MaxSampleAge: 10 * time.Second})
	if err := registry.Put(testProjectID, testInstanceUUID, 0, validSample(now), now); !errors.Is(err, ErrInvalidBodySize) {
		t.Fatalf("zero body error = %v, want ErrInvalidBodySize", err)
	}
	if err := registry.Put(testProjectID, testInstanceUUID, 101, validSample(now), now); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("large body error = %v, want ErrBodyTooLarge", err)
	}
	first := validSample(now.Add(-time.Second))
	if err := registry.Put(testProjectID, testInstanceUUID, 100, first, now); err != nil {
		t.Fatalf("body at exact limit error = %v", err)
	}
	if err := registry.Put(testProjectID, testOtherUUID, 100, validSample(now), now); !errors.Is(err, ErrCapacity) {
		t.Fatalf("second key error = %v, want ErrCapacity", err)
	}
	update := validSample(now)
	update.Snapshot.Sequence = 2
	if err := registry.Put(testProjectID, testInstanceUUID, 100, update, now.Add(time.Second)); err != nil {
		t.Fatalf("update at capacity error = %v", err)
	}
	if removed := registry.Prune(now.Add(11 * time.Second)); removed != 1 {
		t.Fatalf("Prune() removed %d entries, want 1", removed)
	}
	if err := registry.Put(testProjectID, testOtherUUID, 100, validSample(now.Add(10*time.Second)), now.Add(11*time.Second)); err != nil {
		t.Fatalf("Put() after expiry error = %v", err)
	}
}

func TestRegistryPutDefersFullPruneUntilCapacityPressure(t *testing.T) {
	now := testNow()
	registry := mustRegistry(t, Config{
		MaxBodyBytes: 100, MaxEntries: 2, TTL: 2 * time.Second, MaxSampleAge: 2 * time.Second,
	})
	if err := registry.Put(testProjectID, testInstanceUUID, 100, validSample(now), now); err != nil {
		t.Fatal(err)
	}
	later := now.Add(3 * time.Second)
	if err := registry.Put(testProjectID, testOtherUUID, 100, validSample(later), later); err != nil {
		t.Fatal(err)
	}
	// An unrelated, non-pressure Put must not scan the table. The expired first
	// key remains conservatively accounted until Get, Prune, or admission
	// pressure needs to reclaim it.
	firstKey := registryKey{projectID: testProjectID, instanceUUID: testInstanceUUID}
	if _, found := registry.entries[firstKey]; !found {
		t.Fatal("ordinary Put unexpectedly scanned and pruned an unrelated entry")
	}
	thirdUUID := "33333333-3333-4333-8333-333333333333"
	if err := registry.Put(testProjectID, thirdUUID, 100, validSample(later), later); err != nil {
		t.Fatalf("capacity-pressure Put did not reclaim expired state: %v", err)
	}
	if _, found := registry.entries[firstKey]; found {
		t.Fatal("capacity-pressure Put did not prune the expired entry")
	}
}

func TestRegistryTTLGetDeleteAndPrune(t *testing.T) {
	now := testNow()
	registry := mustRegistry(t, Config{TTL: 5 * time.Second, MaxSampleAge: 5 * time.Second})
	if err := registry.Put(testProjectID, testInstanceUUID, 100, validSample(now), now); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if _, ok := registry.Get(testProjectID, testInstanceUUID, now.Add(5*time.Second-time.Nanosecond)); !ok {
		t.Fatal("Get() expired before TTL boundary")
	}
	if _, ok := registry.Get(testProjectID, testInstanceUUID, now.Add(5*time.Second)); ok {
		t.Fatal("Get() returned entry at TTL boundary")
	}
	if registry.Delete(testProjectID, testInstanceUUID) {
		t.Fatal("Delete() found entry already removed by lazy expiry")
	}

	if err := registry.Put(testProjectID, testInstanceUUID, 100, validSample(now.Add(5*time.Second)), now.Add(5*time.Second)); err != nil {
		t.Fatalf("second Put() error = %v", err)
	}
	if !registry.Delete(testProjectID, testInstanceUUID) || registry.Delete(testProjectID, testInstanceUUID) {
		t.Fatal("Delete() result did not reflect exact entry presence")
	}
	if _, ok := registry.Get(testProjectID, testInstanceUUID, now.Add(5*time.Second)); ok {
		t.Fatal("Get() returned deleted entry")
	}
	if removed := registry.Prune(time.Time{}); removed != 0 {
		t.Fatalf("Prune(zero) removed %d entries", removed)
	}
}

func TestRegistryGetAlsoExpiresAtSampleFreshnessBoundary(t *testing.T) {
	now := testNow()
	registry := mustRegistry(t, Config{TTL: time.Minute, MaxSampleAge: 10 * time.Second})
	if err := registry.Put(testProjectID, testInstanceUUID, 100, validSample(now.Add(-8*time.Second)), now); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if _, ok := registry.Get(testProjectID, testInstanceUUID, now.Add(2*time.Second-time.Nanosecond)); !ok {
		t.Fatal("Get() expired before the sample freshness boundary")
	}
	if _, ok := registry.Get(testProjectID, testInstanceUUID, now.Add(2*time.Second)); ok {
		t.Fatal("Get() returned a sample at its freshness boundary")
	}
}

func TestRegistryRetainsReplayWatermarkAcrossFutureSkewWindow(t *testing.T) {
	now := testNow()
	registry := mustRegistry(t, Config{
		TTL: 2 * time.Minute, MaxSampleAge: 2 * time.Minute, MaxFutureSkew: 30 * time.Second,
	})
	future := validSample(now.Add(30 * time.Second))
	if err := registry.Put(testProjectID, testInstanceUUID, 100, future, now); err != nil {
		t.Fatalf("initial future-skewed Put() error = %v", err)
	}
	if _, ok := registry.Get(testProjectID, testInstanceUUID, now.Add(2*time.Minute)); ok {
		t.Fatal("payload survived its receipt TTL")
	}
	if err := registry.Put(testProjectID, testInstanceUUID, 100, future, now.Add(2*time.Minute+time.Second)); !errors.Is(err, ErrReplay) {
		t.Fatalf("replay inside future-skew window error = %v, want ErrReplay", err)
	}
	if err := registry.Put(testProjectID, testInstanceUUID, 100, future, now.Add(2*time.Minute+30*time.Second)); !errors.Is(err, ErrReplay) {
		t.Fatalf("replay at freshness boundary error = %v, want ErrReplay", err)
	}
	if err := registry.Put(testProjectID, testInstanceUUID, 100, future, now.Add(2*time.Minute+30*time.Second+time.Nanosecond)); !errors.Is(err, ErrSampleTooOld) {
		t.Fatalf("post-window replay error = %v, want ErrSampleTooOld", err)
	}
}

func TestRegistryEnforcesGlobalAndPerCreatorRetainedByteBudgets(t *testing.T) {
	now := testNow()
	registry := mustRegistry(t, Config{
		MaxBodyBytes: 100, MaxEntries: 5, MaxRetainedBytes: 250, MaxCreatorBytes: 150,
		TTL: time.Minute, MaxSampleAge: time.Minute,
	})
	put := func(uuid, creator string, bodyBytes int64, sampledAt time.Time) error {
		sample := validSample(sampledAt)
		sample.CreatorID = creator
		return registry.Put(testProjectID, uuid, bodyBytes, sample, now)
	}
	if err := put(testInstanceUUID, testCreatorID, 100, now.Add(-3*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := put(testOtherUUID, testCreatorID, 51, now.Add(-2*time.Second)); !errors.Is(err, ErrCapacity) {
		t.Fatalf("per-creator budget error = %v, want ErrCapacity", err)
	}
	if err := put(testOtherUUID, "nova-user-b", 100, now.Add(-2*time.Second)); err != nil {
		t.Fatal(err)
	}
	thirdUUID := "33333333-3333-4333-8333-333333333333"
	if err := put(thirdUUID, "nova-user-c", 51, now.Add(-time.Second)); !errors.Is(err, ErrCapacity) {
		t.Fatalf("global budget error = %v, want ErrCapacity", err)
	}
	updated := validSample(now)
	updated.CreatorID = testCreatorID
	if err := registry.Put(testProjectID, testInstanceUUID, 50, updated, now); err != nil {
		t.Fatalf("smaller replacement error = %v", err)
	}
	if err := put(thirdUUID, testCreatorID, 100, now.Add(time.Nanosecond)); err != nil {
		t.Fatalf("replacement did not release quota: %v", err)
	}
	if registry.retainedBytes != 250 || registry.creatorRetainedBytes[creatorKey{projectID: testProjectID, creatorID: testCreatorID}] != 150 {
		t.Fatalf("accounting global=%d creators=%v", registry.retainedBytes, registry.creatorRetainedBytes)
	}
	if !registry.Delete(testProjectID, thirdUUID) || registry.retainedBytes != 150 {
		t.Fatalf("Delete did not release accounting: retained=%d", registry.retainedBytes)
	}
}

func TestRegistryRejectsInvalidIdentityAndConfig(t *testing.T) {
	for _, config := range []Config{
		{TTL: -time.Second},
		{TTL: time.Second, MaxSampleAge: 2 * time.Second},
		{MaxBodyBytes: -1},
		{MaxEntries: -1},
		{MaxRetainedBytes: -1},
		{MaxCreatorBytes: -1},
		{MaxBodyBytes: 100, MaxCreatorBytes: 99},
		{MaxCreatorBytes: 101, MaxRetainedBytes: 100},
		{MaxRetainedBytes: MaximumMaxRetainedBytes + 1},
		{MaxCreatorBytes: MaximumMaxCreatorBytes + 1},
		{MaxFieldBytes: -1},
	} {
		if _, err := New(config); !errors.Is(err, ErrInvalidConfig) {
			t.Fatalf("New(%+v) error = %v, want ErrInvalidConfig", config, err)
		}
	}
	registry := mustRegistry(t, Config{})
	now := testNow()
	for _, identity := range []struct{ projectID, instanceUUID string }{
		{projectID: " project", instanceUUID: testInstanceUUID},
		{projectID: "project\n", instanceUUID: testInstanceUUID},
		{projectID: testProjectID, instanceUUID: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"},
		{projectID: testProjectID, instanceUUID: "not-a-uuid"},
	} {
		if err := registry.Put(identity.projectID, identity.instanceUUID, 100, validSample(now), now); !errors.Is(err, ErrInvalidIdentity) {
			t.Fatalf("Put(%q, %q) error = %v, want ErrInvalidIdentity", identity.projectID, identity.instanceUUID, err)
		}
	}
}

func TestRegistryConcurrentAccess(t *testing.T) {
	const workers = 64
	now := testNow()
	registry := mustRegistry(t, Config{MaxEntries: workers, TTL: time.Minute, MaxSampleAge: time.Minute})
	errorsChannel := make(chan error, workers)
	var group sync.WaitGroup
	for index := 0; index < workers; index++ {
		index := index
		group.Add(1)
		go func() {
			defer group.Done()
			uuid := fmt.Sprintf("00000000-0000-4000-8000-%012x", index+1)
			sample := validSample(now.Add(time.Duration(index) * time.Nanosecond))
			if err := registry.Put(testProjectID, uuid, 100, sample, now); err != nil {
				errorsChannel <- fmt.Errorf("Put(%s): %w", uuid, err)
				return
			}
			stored, ok := registry.Get(testProjectID, uuid, now)
			if !ok || stored.InstanceUUID != uuid || stored.Source != fleet.TelemetrySourceLeviathanUplink {
				errorsChannel <- fmt.Errorf("Get(%s): ok=%v sample=%+v", uuid, ok, stored)
				return
			}
			stored.Snapshot.GPUs[0].Name = "caller mutation"
		}()
	}
	group.Wait()
	close(errorsChannel)
	for err := range errorsChannel {
		t.Error(err)
	}
	if removed := registry.Prune(now.Add(time.Minute)); removed != workers {
		t.Fatalf("Prune() removed %d entries, want %d", removed, workers)
	}
}

func mustRegistry(t *testing.T, config Config) *Registry {
	t.Helper()
	registry, err := New(config)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return registry
}

func testNow() time.Time {
	return time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)
}

func validSample(sampledAt time.Time) fleet.AgentSample {
	startTime := sampledAt.Add(-time.Minute)
	attributionTime := sampledAt.Add(-time.Second)
	return fleet.AgentSample{
		InstanceUUID: testInstanceUUID,
		CreatorID:    testCreatorID,
		Source:       fleet.TelemetrySourceLeviathanAgent,
		ObservedAt:   sampledAt,
		BuildInfo: &model.BuildInfo{
			Version:   "v0.2.0",
			Commit:    "0123456789abcdef",
			BuildDate: "2026-08-30T12:00:00Z",
		},
		Snapshot: model.Snapshot{
			SchemaVersion: "v1",
			Sequence:      1,
			SampledAt:     sampledAt,
			Host:          model.Host{Hostname: "payload-host", OS: "linux", Arch: "amd64"},
			GPUs: []model.GPU{{
				UUID:     "GPU-1",
				Index:    0,
				Name:     "test GPU",
				PCIBusID: "0000:01:00.0",
				Memory:   availableMemory(80, 20, 60, model.ScopePhysicalGPU, sampledAt),
				Metrics:  model.MetricSet{"gpu_util": model.AvailableMetric(42, "%", model.SourceNVML, model.ScopePhysicalGPU, sampledAt)},
				GPUInstances: []model.GPUInstance{{
					UUID:       "MIG-1",
					ID:         1,
					Profile:    "1g.10gb",
					Generation: "generation-1",
					Memory:     availableMemory(10, 2, 8, model.ScopeGPUInstance, sampledAt),
					Metrics:    model.MetricSet{},
					ComputeInstances: []model.ComputeInstance{{
						UUID:       "CI-1",
						ID:         1,
						Profile:    "1g.10gb",
						Generation: "generation-1",
						Memory:     availableMemory(10, 2, 8, model.ScopeComputeInstance, sampledAt),
						Metrics:    model.MetricSet{},
						Diagnostics: []model.Diagnostic{{
							Code: "compute_ok", Severity: "info", Component: "compute", Summary: "compute healthy", Status: model.StatusAvailable,
						}},
					}},
				}},
			}},
			Processes: []model.Process{{
				PID: 42, User: "gpu-user", Executable: "/usr/bin/python", CommandLine: "python train.py", StartTime: &startTime,
				WorkloadRef: "workload-1", Status: model.StatusAvailable,
			}},
			Attribution: &model.Attribution{
				Provider:   model.AttributionProviderKubernetesDRA,
				Status:     model.AttributionAvailable,
				ObservedAt: &attributionTime,
				Workloads: []model.WorkloadAttribution{{
					Ref: "workload-1", Platform: model.WorkloadPlatformCoder, Kind: model.WorkloadKindWorkspace, Name: "workspace", OwnerName: "owner",
				}},
				Assignments: []model.ResourceAssignment{{
					WorkloadRef: "workload-1", EntityType: model.AllocationEntityComputeInstance, EntityUUID: "CI-1", State: model.AllocationStateAllocated,
				}},
			},
			Capabilities: model.Capabilities{
				NVML: model.ProviderState{Name: "NVML", Available: true, Status: model.StatusAvailable},
				GPM:  model.ProviderState{Name: "GPM", Available: false, Status: model.StatusUnsupported},
				DCGM: model.ProviderState{Name: "DCGM", Available: false, Status: model.StatusUnsupported},
				Proc: model.ProviderState{Name: "/proc", Available: true, Status: model.StatusAvailable},
			},
			Diagnostics: []model.Diagnostic{{
				Code: "healthy", Severity: "info", Component: "collector", Summary: "healthy", Detail: "all providers ready", Status: model.StatusAvailable,
			}},
		},
	}
}

func availableMemory(total, used, free uint64, scope model.MetricScope, at time.Time) model.Memory {
	return model.Memory{
		TotalBytes: model.Uint64(total),
		UsedBytes:  model.Uint64(used),
		FreeBytes:  model.Uint64(free),
		Source:     model.SourceNVML,
		Scope:      scope,
		SampledAt:  at,
		Status:     model.StatusAvailable,
	}
}

func updateFirstMetric(sample *fleet.AgentSample, update func(*model.Metric)) {
	metric := sample.Snapshot.GPUs[0].Metrics["gpu_util"]
	update(&metric)
	sample.Snapshot.GPUs[0].Metrics["gpu_util"] = metric
}
