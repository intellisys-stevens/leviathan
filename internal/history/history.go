package history

import (
	"sort"
	"sync"
	"time"

	"github.com/intellisys-stevens/miglens/internal/model"
)

type Point struct {
	SampledAt time.Time          `json:"sampledAt"`
	Values    map[string]float64 `json:"values"`
}

type Series struct {
	Entity  string   `json:"entity"`
	Metrics []string `json:"metrics"`
	Window  string   `json:"window"`
	Points  []Point  `json:"points"`
}

type Buffer struct {
	mu       sync.RWMutex
	window   time.Duration
	interval time.Duration
	capacity int
	series   map[string]*ring
}

type ring struct {
	points []Point
	next   int
	full   bool
	last   time.Time
}

func New(window, interval time.Duration) *Buffer {
	if interval <= 0 {
		interval = time.Second
	}
	capacity := int(window/interval) + 2
	if capacity < 2 {
		capacity = 2
	}
	return &Buffer{window: window, interval: interval, capacity: capacity, series: make(map[string]*ring)}
}

func (b *Buffer) Add(snapshot model.Snapshot) {
	b.mu.Lock()
	defer b.mu.Unlock()
	cutoff := snapshot.SampledAt.Add(-b.window)
	for entity, series := range b.series {
		if !series.last.IsZero() && series.last.Before(cutoff) {
			delete(b.series, entity)
		}
	}
	for _, gpu := range snapshot.GPUs {
		b.add(gpu.UUID, snapshot.SampledAt, valuesFor(gpu.Metrics, gpu.Memory))
		for _, gi := range gpu.GPUInstances {
			entity := gi.Generation
			if entity == "" {
				entity = gi.UUID
			}
			b.add(entity, snapshot.SampledAt, valuesFor(gi.Metrics, gi.Memory))
			for _, ci := range gi.ComputeInstances {
				entity := ci.Generation
				if entity == "" {
					entity = ci.UUID
				}
				b.add(entity, snapshot.SampledAt, valuesFor(ci.Metrics, ci.Memory))
			}
		}
	}
}

func valuesFor(metrics model.MetricSet, memory model.Memory) map[string]float64 {
	values := make(map[string]float64, len(metrics)+3)
	for name, metric := range metrics {
		if metric.Status == model.StatusAvailable && metric.Value != nil {
			values[name] = *metric.Value
		}
	}
	if memory.Status == model.StatusAvailable {
		if memory.UsedBytes != nil {
			values["memory_used_bytes"] = float64(*memory.UsedBytes)
		}
		if memory.TotalBytes != nil {
			values["memory_total_bytes"] = float64(*memory.TotalBytes)
		}
	}
	return values
}

func (b *Buffer) add(entity string, at time.Time, values map[string]float64) {
	if entity == "" {
		return
	}
	r := b.series[entity]
	if r == nil {
		r = &ring{points: []Point{}}
		b.series[entity] = r
	}
	point := Point{SampledAt: at, Values: values}
	if len(r.points) < b.capacity {
		r.points = append(r.points, point)
		if len(r.points) == b.capacity {
			r.next = 0
			r.full = true
		}
	} else {
		r.points[r.next] = point
		r.next = (r.next + 1) % b.capacity
		r.full = true
	}
	r.last = at
}

func (b *Buffer) Query(entity string, metrics []string, window time.Duration, now time.Time) Series {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if window <= 0 || window > b.window {
		window = b.window
	}
	result := Series{Entity: entity, Metrics: append([]string(nil), metrics...), Window: window.String(), Points: []Point{}}
	r := b.series[entity]
	if r == nil {
		return result
	}
	ordered := r.ordered()
	cutoff := now.Add(-window)
	allow := make(map[string]bool, len(metrics))
	for _, metric := range metrics {
		allow[metric] = true
	}
	for _, point := range ordered {
		if point.SampledAt.Before(cutoff) {
			continue
		}
		values := point.Values
		if len(allow) > 0 {
			values = make(map[string]float64)
			for name, value := range point.Values {
				if allow[name] {
					values[name] = value
				}
			}
		}
		result.Points = append(result.Points, Point{SampledAt: point.SampledAt, Values: values})
	}
	return result
}

// EnsureCapacity grows every entity ring for a faster sampling interval. It
// never shrinks capacity, so changing cadence cannot discard retained points.
func (b *Buffer) EnsureCapacity(interval time.Duration) {
	if interval <= 0 {
		return
	}
	capacity := int(b.window/interval) + 2
	if capacity < 2 {
		capacity = 2
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	if capacity <= b.capacity {
		return
	}
	for _, r := range b.series {
		ordered := r.ordered()
		r.points = ordered
		r.next = 0
		r.full = false
	}
	b.interval = interval
	b.capacity = capacity
}

func (r *ring) ordered() []Point {
	if !r.full {
		return append([]Point(nil), r.points...)
	}
	out := append([]Point(nil), r.points[r.next:]...)
	out = append(out, r.points[:r.next]...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].SampledAt.Before(out[j].SampledAt) })
	return out
}

func (b *Buffer) Capacity() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.capacity
}
