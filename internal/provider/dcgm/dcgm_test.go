package dcgm

import (
	"context"
	"fmt"
	"math"
	"testing"
	"time"

	ndcgm "github.com/NVIDIA/go-dcgm/pkg/dcgm"
	"github.com/intellisys-stevens/miglens/internal/model"
)

func TestGPUActivityProfilingFieldIsCollected(t *testing.T) {
	found := false
	for _, field := range profileFields {
		if field == ndcgm.DCGM_FI_PROF_GR_ENGINE_UTIL_RATIO {
			found = true
			break
		}
	}
	if !found || profileNames[ndcgm.DCGM_FI_PROF_GR_ENGINE_UTIL_RATIO] != "gpu_activity" {
		t.Fatalf("GPU activity DCGM mapping is missing: fields=%v names=%v", profileFields, profileNames)
	}
}

func TestProfileWatchDefaultsToTwoSeconds(t *testing.T) {
	p := New(nil, Options{})
	if p.options.Interval != 2*time.Second || p.options.StaleAfter != 6*time.Second {
		t.Fatalf("DCGM profile defaults = interval %s stale %s", p.options.Interval, p.options.StaleAfter)
	}
}

func TestPCIeProfilingFieldsUseBytesPerSecond(t *testing.T) {
	for field, name := range map[ndcgm.Short]string{
		ndcgm.DCGM_FI_PROF_PCIE_TX_BYTES: "pcie_tx_bytes_per_second",
		ndcgm.DCGM_FI_PROF_PCIE_RX_BYTES: "pcie_rx_bytes_per_second",
	} {
		descriptor, ok := profileDescriptors[field]
		if !ok || descriptor.name != name || descriptor.unit != "bytes_per_second" || descriptor.scale != 1 || descriptor.percent {
			t.Fatalf("DCGM PCIe descriptor %d = %+v", field, descriptor)
		}
	}
}

func TestDCGMMetricNormalizationRespectsDescriptorUnits(t *testing.T) {
	at := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	percent, blank := dcgmMetricValue(profileDescriptors[ndcgm.DCGM_FI_PROF_SM_UTIL_RATIO], 0.723, at)
	if blank || percent.Value == nil || math.Abs(*percent.Value-72.3) > 0.0001 || percent.Unit != "percent" {
		t.Fatalf("DCGM ratio metric = %+v, blank=%t", percent, blank)
	}

	throughput, blank := dcgmMetricValue(profileDescriptors[ndcgm.DCGM_FI_PROF_PCIE_RX_BYTES], 987654321, at)
	if blank || throughput.Value == nil || *throughput.Value != 987654321 || throughput.Unit != "bytes_per_second" {
		t.Fatalf("DCGM throughput metric = %+v, blank=%t", throughput, blank)
	}

	unsupported, blank := dcgmMetricValue(profileDescriptors[ndcgm.DCGM_FI_PROF_PCIE_RX_BYTES], ndcgm.DCGM_FT_FP64_NOT_SUPPORTED, at)
	if !blank || unsupported.Value != nil || unsupported.Status != model.StatusUnsupported || unsupported.Unit != "bytes_per_second" {
		t.Fatalf("DCGM unsupported throughput metric = %+v, blank=%t", unsupported, blank)
	}
}

func TestDCGMTimestampPreservesFieldSampleTime(t *testing.T) {
	fallback := time.Date(2026, 8, 30, 12, 0, 5, 0, time.UTC)
	sampled := time.Date(2026, 8, 30, 12, 0, 3, 125000000, time.UTC)
	if got := dcgmSampledAt(sampled.UnixMicro(), fallback); !got.Equal(sampled) {
		t.Fatalf("DCGM sample timestamp = %s, want %s", got, sampled)
	}
	if got := dcgmSampledAt(0, fallback); !got.Equal(fallback) {
		t.Fatalf("DCGM missing timestamp fallback = %s, want %s", got, fallback)
	}
}

type cadenceTestBase struct{}

func (cadenceTestBase) Name() string                     { return "test" }
func (cadenceTestBase) Open(context.Context) error       { return nil }
func (cadenceTestBase) Close() error                     { return nil }
func (cadenceTestBase) Capabilities() model.Capabilities { return model.Capabilities{} }
func (cadenceTestBase) Sample(_ context.Context, at time.Time) (model.Snapshot, error) {
	instances := make([]model.GPUInstance, 0, 2)
	for id := uint32(1); id <= 2; id++ {
		instances = append(instances, model.GPUInstance{
			UUID: fmt.Sprintf("GPU-test/gi/%d", id), ID: id, Profile: "1g.24gb", Generation: "generation-a",
			Metrics: model.MetricSet{}, ComputeInstances: []model.ComputeInstance{{UUID: "MIG-test", ID: 0, Profile: "1c.1g.24gb", Generation: "MIG-test"}},
		})
	}
	return model.Snapshot{
		SampledAt: at,
		GPUs:      []model.GPU{{UUID: "GPU-test", Metrics: model.MetricSet{}, GPUInstances: instances}},
	}, nil
}

func TestSampleQueriesEachGIOnlyAtProfileInterval(t *testing.T) {
	at := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	p := New(cadenceTestBase{}, Options{Interval: 2 * time.Second, StaleAfter: 5 * time.Second, RescanInterval: time.Hour})
	p.mu.Lock()
	p.available = true
	p.refreshedAt = at
	p.entities[dcgmKey("GPU-test", 1)] = 101
	p.entities[dcgmKey("GPU-test", 2)] = 102
	p.mu.Unlock()
	updates, queries := 0, 0
	p.updateAllFields = func() error {
		updates++
		return nil
	}
	p.latestValues = func(_ ndcgm.Field_Entity_Group, _ uint, _ []ndcgm.Short) ([]ndcgm.FieldValue_v1, error) {
		queries++
		return nil, nil
	}

	first, err := p.Sample(context.Background(), at)
	if err != nil {
		t.Fatal(err)
	}
	if updates != 1 || queries != 2 {
		t.Fatalf("initial DCGM calls = updates %d queries %d", updates, queries)
	}
	if metric := first.GPUs[0].GPUInstances[0].Metrics["sm_activity"]; metric.Status != model.StatusStale || !metric.SampledAt.Equal(at) {
		t.Fatalf("initial missing DCGM metric = %+v", metric)
	}

	queriesPerTick := make([]int, 0, 8)
	for offset := 250 * time.Millisecond; offset <= 2*time.Second; offset += 250 * time.Millisecond {
		before := queries
		if _, err := p.Sample(context.Background(), at.Add(offset)); err != nil {
			t.Fatal(err)
		}
		queriesPerTick = append(queriesPerTick, queries-before)
	}
	if queries != 4 {
		t.Fatalf("staggered profile window queries = %d, want initial 2 plus one per GI; per tick=%v", queries, queriesPerTick)
	}
	if updates < 2 || updates > 3 {
		t.Fatalf("staggered DCGM updates = %d, want one initial plus one or two due ticks", updates)
	}
	if queriesPerTick[1] != 0 {
		t.Fatalf("fixed sub-interval tick unexpectedly queried every GI: %v", queriesPerTick)
	}
}

func TestProfileCachePreservesTimestampAndStalesAtConfiguredBoundary(t *testing.T) {
	at := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	p := New(nil, Options{Interval: 2 * time.Second, StaleAfter: 4500 * time.Millisecond})
	state := &profileState{}
	p.storeProfileMetrics(state, model.MetricSet{
		"sm_activity": model.AvailableMetric(64, "percent", model.SourceDCGM, model.ScopeGPUInstance, at),
	})
	p.storeProfileMetrics(state, model.MetricSet{
		"sm_activity": model.UnavailableMetric("percent", model.SourceDCGM, model.ScopeGPUInstance, at.Add(2*time.Second), model.StatusError, "temporary query failure"),
	})

	atBoundary := p.cachedProfileMetrics(state, at.Add(4500*time.Millisecond))["sm_activity"]
	if atBoundary.Value == nil || *atBoundary.Value != 64 || !atBoundary.SampledAt.Equal(at) {
		t.Fatalf("metric staled at rather than after boundary: %+v", atBoundary)
	}
	afterBoundary := p.cachedProfileMetrics(state, at.Add(4500*time.Millisecond+time.Nanosecond))["sm_activity"]
	if afterBoundary.Value != nil || afterBoundary.Status != model.StatusStale || !afterBoundary.SampledAt.Equal(at) {
		t.Fatalf("expired DCGM cache = %+v", afterBoundary)
	}
}

func TestProfileCacheResetsWhenGITopologyChanges(t *testing.T) {
	at := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	p := New(nil, Options{})
	old := model.GPUInstance{UUID: "GPU-test/gi/1", ID: 1, Profile: "1g.24gb", Generation: "generation-a", ComputeInstances: []model.ComputeInstance{{UUID: "MIG-old", ID: 0, Profile: "1c.1g.24gb"}}}
	oldKey := dcgmProfileKey("GPU-test", old)
	if _, due := p.profileStateFor(oldKey, at); !due {
		t.Fatal("new DCGM topology was not immediately due")
	}
	updated := old
	updated.ComputeInstances = []model.ComputeInstance{{UUID: "MIG-new", ID: 0, Profile: "1c.1g.24gb"}}
	newKey := dcgmProfileKey("GPU-test", updated)
	if newKey == oldKey {
		t.Fatal("DCGM cache key survived a compute-instance replacement")
	}
	if _, due := p.profileStateFor(newKey, at); !due {
		t.Fatal("replacement topology reused the old schedule")
	}
	p.pruneProfileStates(map[string]bool{newKey: true})
	if len(p.profiles) != 1 || p.profiles[newKey] == nil {
		t.Fatalf("old topology cache was retained: %+v", p.profiles)
	}
}
