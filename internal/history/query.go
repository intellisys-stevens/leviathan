package history

import (
	"slices"
	"time"
)

type historyDomain uint8

type entityDomain struct {
	kind historyDomain
	last time.Time
}

const (
	systemDomain historyDomain = iota + 1
	gpuDomain
	workloadDomain
)

// queryView owns its slices; only immutable raw value maps are shared with the
// buffer. Aggregate values are packed into slices while locked, since a delayed
// observation may update any retained bucket. Filtering, ordering, joins, and
// result allocation happen after the buffer lock is released.
type queryView struct {
	aggregated         bool
	series             map[string][]Point
	aggregates         map[string][]aggregateSample
	domains            [3]bool
	timelines          [3][]timelineSample
	aggregateTimelines [3][]aggregateTimelinePoint
}

type aggregateSample struct {
	start   time.Time
	samples int
	values  []namedAggregateMetric
}

type namedAggregateMetric struct {
	name   string
	metric aggregateMetric
}

// Aligned timestamps and entity points are ordered. Advancing through them
// avoids allocating a second timestamp index for every requested series.
type pointCursor struct {
	points []Point
	next   int
}

func (c *pointCursor) at(at time.Time) (Point, bool) {
	for c.next < len(c.points) && !c.points[c.next].SampledAt.After(at) {
		c.next++
	}
	if c.next > 0 && c.points[c.next-1].SampledAt.Equal(at) {
		return c.points[c.next-1], true
	}
	return Point{}, false
}

func (b *Buffer) copyForQuery(entities []string, window time.Duration, aligned bool) (*queryView, time.Duration) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if window <= 0 || window > b.window {
		window = b.window
	}
	view := &queryView{aggregated: window > b.rawWindow && b.aggregateCapacity > 0}
	if view.aggregated {
		view.aggregates = make(map[string][]aggregateSample, len(entities))
	} else {
		view.series = make(map[string][]Point, len(entities))
	}
	for _, entity := range entities {
		if view.aggregated {
			if _, copied := view.aggregates[entity]; copied {
				continue
			}
			view.aggregates[entity] = nil
			if r := b.aggregates[entity]; r != nil {
				count := 0
				for _, point := range r.points {
					count += len(point.values)
				}
				values := make([]namedAggregateMetric, 0, count)
				points := make([]aggregateSample, len(r.points))
				for i := range points {
					index := i
					if r.full {
						index = (r.next + i) % len(r.points)
					}
					point := r.points[index]
					start := len(values)
					for name, metric := range point.values {
						values = append(values, namedAggregateMetric{name, metric})
					}
					points[i] = aggregateSample{point.start, point.samples, values[start:len(values)]}
				}
				view.aggregates[entity] = points
			}
		} else {
			if _, copied := view.series[entity]; copied {
				continue
			}
			view.series[entity] = nil
			if r := b.series[entity]; r != nil {
				view.series[entity] = copyRing(r.points, r.next, r.full)
			}
		}
	}
	if !view.aggregated && !aligned {
		return view, window
	}
	view.domains[0], view.domains[1], view.domains[2] = b.historyDomains(entities)
	if view.aggregated {
		for i, ring := range []*aggregateTimelineRing{&b.systemAggregateTimeline, &b.aggregateTimeline, &b.workloadAggregateTimeline} {
			if view.domains[i] {
				view.aggregateTimelines[i] = copyRing(ring.points, ring.next, ring.full)
			}
		}
	} else {
		for i, ring := range []*timelineRing{&b.systemTimeline, &b.timeline, &b.workloadTimeline} {
			if view.domains[i] {
				view.timelines[i] = copyRing(ring.samples, ring.next, ring.full)
			}
		}
	}
	return view, window
}

func copyRing[T any](values []T, next int, full bool) []T {
	result := make([]T, len(values))
	if full {
		copied := copy(result, values[next:])
		copy(result[copied:], values[:next])
	} else {
		copy(result, values)
	}
	return result
}

func orderPoints(points []Point) []Point {
	compare := func(a, b Point) int { return a.SampledAt.Compare(b.SampledAt) }
	if !slices.IsSortedFunc(points, compare) {
		slices.SortStableFunc(points, compare)
	}
	return points
}

func orderTimeline(samples []timelineSample) []timelineSample {
	compare := func(a, b timelineSample) int { return a.sampledAt.Compare(b.sampledAt) }
	if !slices.IsSortedFunc(samples, compare) {
		slices.SortStableFunc(samples, compare)
	}
	return samples
}

func orderAggregateTimeline(points []aggregateTimelinePoint) []aggregateTimelinePoint {
	compare := func(a, b aggregateTimelinePoint) int { return a.start.Compare(b.start) }
	if !slices.IsSortedFunc(points, compare) {
		slices.SortStableFunc(points, compare)
	}
	return points
}
