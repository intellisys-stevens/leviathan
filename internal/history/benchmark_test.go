package history

import (
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/model"
)

// These fixtures seed one hour of input and exercise three metrics used by the
// dashboard. Run with -benchmem against a matched baseline.
func benchmarkHistory(b *testing.B) (*Buffer, time.Time, []SeriesDescriptor) {
	return benchmarkHistoryWindow(b, 30*time.Minute)
}

func benchmarkHistoryWindow(b *testing.B, window time.Duration) (*Buffer, time.Time, []SeriesDescriptor) {
	b.Helper()
	buffer := New(window, time.Second)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	metrics := []string{"sm_activity", "pcie_rx_bytes_per_second", "pcie_tx_bytes_per_second"}
	descriptors := make([]SeriesDescriptor, 8)
	for gpu := range descriptors {
		id := fmt.Sprintf("GPU-%d", gpu)
		descriptors[gpu] = SeriesDescriptor{Key: id, Entity: id, Metrics: metrics}
	}
	for sample := 0; sample < 3600; sample++ {
		at := base.Add(time.Duration(sample) * time.Second)
		snapshot := model.Snapshot{SampledAt: at, Sequence: uint64(sample + 1)}
		for gpu, descriptor := range descriptors {
			values := model.MetricSet{}
			for _, metric := range metrics {
				values[metric] = model.AvailableMetric(float64((sample+gpu)%100), "percent", model.SourceSynthetic, model.ScopePhysicalGPU, at)
			}
			snapshot.GPUs = append(snapshot.GPUs, model.GPU{UUID: descriptor.Entity, Metrics: values})
		}
		buffer.Add(snapshot)
	}
	return buffer, base.Add(3599 * time.Second), descriptors
}

func BenchmarkQueryAggregate(b *testing.B) {
	buffer, now, descriptors := benchmarkHistoryWindow(b, 12*time.Hour)
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		_ = buffer.QueryAligned(descriptors, 4*time.Hour, 300, now)
	}
}

// This is a contention workload, not a real-time sampling rate. A writer fills
// the same bounded rings while one reader continuously requests eight series.
func BenchmarkWriterWithAlignedReader(b *testing.B) {
	benchmarkWriterWithReader(b, 30*time.Minute, 30*time.Minute)
}

func BenchmarkWriterWithAggregateReader(b *testing.B) {
	benchmarkWriterWithReader(b, 12*time.Hour, 4*time.Hour)
}

func benchmarkWriterWithReader(b *testing.B, retention, window time.Duration) {
	buffer, now, descriptors := benchmarkHistoryWindow(b, retention)
	snapshot := model.Snapshot{SampledAt: now}
	for _, descriptor := range descriptors {
		metrics := model.MetricSet{}
		for _, name := range descriptor.Metrics {
			metrics[name] = model.AvailableMetric(50, "percent", model.SourceSynthetic, model.ScopePhysicalGPU, now)
		}
		snapshot.GPUs = append(snapshot.GPUs, model.GPU{UUID: descriptor.Entity, Metrics: metrics})
	}
	var latest, reads atomic.Int64
	latest.Store(now.UnixNano())
	stop, stopped, ready := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		for {
			_ = buffer.QueryAligned(descriptors, window, 300, time.Unix(0, latest.Load()))
			if reads.Add(1) == 1 {
				close(ready)
			}
			select {
			case <-stop:
				return
			default:
			}
		}
	}()
	<-ready
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		snapshot.SampledAt = snapshot.SampledAt.Add(time.Millisecond)
		buffer.AddGPU(snapshot)
		latest.Store(snapshot.SampledAt.UnixNano())
	}
	close(stop)
	<-stopped
	b.ReportMetric(float64(reads.Load())/b.Elapsed().Seconds(), "reader_queries/s")
}

func BenchmarkQuery(b *testing.B) {
	buffer, now, descriptors := benchmarkHistory(b)
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		_ = buffer.Query(descriptors[0].Entity, descriptors[0].Metrics, 30*time.Minute, now)
	}
}

func BenchmarkQueryAligned(b *testing.B) {
	buffer, now, descriptors := benchmarkHistory(b)
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		_ = buffer.QueryAligned(descriptors, 30*time.Minute, 300, now)
	}
}
