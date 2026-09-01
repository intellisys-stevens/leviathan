package history

import (
	"sort"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
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

// SeriesDescriptor identifies one independently named entity/metric set in an
// aligned history request. Keys are supplied by the caller and are used to
// address values in every shared timestamp row.
type SeriesDescriptor struct {
	Key     string   `json:"key"`
	Entity  string   `json:"entity"`
	Metrics []string `json:"metrics"`
}

type AlignedRequest struct {
	Window    string             `json:"window"`
	MaxPoints int                `json:"maxPoints"`
	Series    []SeriesDescriptor `json:"series"`
}

type AlignedPoint struct {
	SampledAt time.Time                     `json:"sampledAt"`
	Values    map[string]map[string]float64 `json:"values"`
}

type AlignedSeries struct {
	Window string             `json:"window"`
	Series []SeriesDescriptor `json:"series"`
	Points []AlignedPoint     `json:"points"`
}

// Limit preserves the first and last points plus per-metric extrema across
// evenly sized buckets, then fills any remaining budget with evenly spaced
// points. The returned series never exceeds maxPoints.
func Limit(series Series, maxPoints int) Series {
	if maxPoints <= 0 || len(series.Points) <= maxPoints {
		return series
	}
	if maxPoints < 2 {
		series.Points = append([]Point(nil), series.Points[:maxPoints]...)
		return series
	}

	metrics := append([]string(nil), series.Metrics...)
	if len(metrics) == 0 {
		seen := make(map[string]struct{})
		for _, point := range series.Points {
			for name := range point.Values {
				seen[name] = struct{}{}
			}
		}
		metrics = make([]string, 0, len(seen))
		for name := range seen {
			metrics = append(metrics, name)
		}
		sort.Strings(metrics)
	}

	selected := make([]bool, len(series.Points))
	selected[0], selected[len(selected)-1] = true, true
	selectedCount := 2
	budget := maxPoints - selectedCount
	interior := len(series.Points) - 2
	if budget > 0 && interior > 0 && len(metrics) > 0 {
		bucketCount := budget / (2 * len(metrics))
		if bucketCount > interior {
			bucketCount = interior
		}
		for bucket := 0; bucket < bucketCount; bucket++ {
			start := 1 + interior*bucket/bucketCount
			end := 1 + interior*(bucket+1)/bucketCount
			for _, metric := range metrics {
				minimum, maximum := -1, -1
				for index := start; index < end; index++ {
					value, ok := series.Points[index].Values[metric]
					if !ok {
						continue
					}
					if minimum < 0 || value < series.Points[minimum].Values[metric] {
						minimum = index
					}
					if maximum < 0 || value > series.Points[maximum].Values[metric] {
						maximum = index
					}
				}
				for _, index := range []int{minimum, maximum} {
					if index >= 0 && !selected[index] && selectedCount < maxPoints {
						selected[index] = true
						selectedCount++
					}
				}
			}
		}
	}

	if selectedCount < maxPoints {
		candidates := make([]int, 0, interior)
		for index := 1; index < len(selected)-1; index++ {
			if !selected[index] {
				candidates = append(candidates, index)
			}
		}
		remaining := maxPoints - selectedCount
		if remaining > len(candidates) {
			remaining = len(candidates)
		}
		for slot := 0; slot < remaining; slot++ {
			index := candidates[slot*len(candidates)/remaining]
			selected[index] = true
		}
	}

	points := make([]Point, 0, maxPoints)
	for index, keep := range selected {
		if keep {
			points = append(points, series.Points[index])
		}
	}
	series.Points = points
	return series
}

type Buffer struct {
	mu                sync.RWMutex
	window            time.Duration
	rawWindow         time.Duration
	interval          time.Duration
	capacity          int
	aggregateCapacity int
	series            map[string]*ring
	timeline          timelineRing
	aggregates        map[string]*aggregateRing
	aggregateTimeline aggregateTimelineRing
	lastTimeline      timelineSample
}

const (
	maximumRawWindow    = time.Hour
	aggregateBucketSize = 30 * time.Second
	longRollupSize      = 2 * time.Minute
)

type ring struct {
	points []Point
	next   int
	full   bool
	last   time.Time
}

type timelineSample struct {
	sampledAt time.Time
	interval  time.Duration
	sequence  uint64
	gap       bool
}

type timelineRing struct {
	samples []timelineSample
	next    int
	full    bool
}

type aggregateMetric struct {
	count   int
	latest  float64
	maximum float64
	minimum float64
	sum     float64
}

type aggregatePoint struct {
	start   time.Time
	samples int
	values  map[string]aggregateMetric
}

type aggregateRing struct {
	points []aggregatePoint
	next   int
	full   bool
	last   time.Time
}

type aggregateTimelinePoint struct {
	start time.Time
	gap   bool
}

type aggregateTimelineRing struct {
	points []aggregateTimelinePoint
	next   int
	full   bool
}

func New(window, interval time.Duration) *Buffer {
	if interval <= 0 {
		interval = time.Second
	}
	rawWindow := window
	if rawWindow > maximumRawWindow {
		rawWindow = maximumRawWindow
	}
	capacity := int(rawWindow/interval) + 2
	if capacity < 2 {
		capacity = 2
	}
	aggregateCapacity := 0
	if window > rawWindow {
		aggregateCapacity = int(window/aggregateBucketSize) + 2
	}
	return &Buffer{
		window:            window,
		rawWindow:         rawWindow,
		interval:          interval,
		capacity:          capacity,
		aggregateCapacity: aggregateCapacity,
		series:            make(map[string]*ring),
		aggregates:        make(map[string]*aggregateRing),
	}
}

func (b *Buffer) Add(snapshot model.Snapshot) {
	b.mu.Lock()
	defer b.mu.Unlock()
	timeline := timelineSample{
		sampledAt: snapshot.SampledAt,
		interval:  b.interval,
		sequence:  snapshot.Sequence,
	}
	b.addTimeline(timeline)
	b.addAggregateTimeline(timeline)
	b.prune(snapshot.SampledAt)
	for _, gpu := range snapshot.GPUs {
		values := valuesFor(gpu.Metrics, gpu.Memory)
		b.add(gpu.UUID, snapshot.SampledAt, values)
		b.addAggregate(gpu.UUID, snapshot.SampledAt, values)
		for _, gi := range gpu.GPUInstances {
			entity := gi.Generation
			if entity == "" {
				entity = gi.UUID
			}
			values := valuesFor(gi.Metrics, gi.Memory)
			b.add(entity, snapshot.SampledAt, values)
			b.addAggregate(entity, snapshot.SampledAt, values)
			for _, ci := range gi.ComputeInstances {
				entity := ci.Generation
				if entity == "" {
					entity = ci.UUID
				}
				values := valuesFor(ci.Metrics, ci.Memory)
				b.add(entity, snapshot.SampledAt, values)
				b.addAggregate(entity, snapshot.SampledAt, values)
			}
		}
	}
}

// AddGap records a failed collection timestamp for aligned history without
// changing any legacy per-entity series. The empty shared row makes the outage
// explicit while retaining only values that were actually collected.
func (b *Buffer) AddGap(at time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	timeline := timelineSample{sampledAt: at, interval: b.interval, gap: true}
	b.addTimeline(timeline)
	b.addAggregateTimeline(timeline)
	b.prune(at)
}

func (b *Buffer) prune(at time.Time) {
	rawCutoff := at.Add(-b.rawWindow)
	for entity, series := range b.series {
		if !series.last.IsZero() && series.last.Before(rawCutoff) {
			delete(b.series, entity)
		}
	}
	aggregateCutoff := at.Add(-b.window)
	for entity, series := range b.aggregates {
		if !series.last.IsZero() && series.last.Before(aggregateCutoff) {
			delete(b.aggregates, entity)
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

func (b *Buffer) addTimeline(sample timelineSample) {
	if len(b.timeline.samples) < b.capacity {
		b.timeline.samples = append(b.timeline.samples, sample)
		if len(b.timeline.samples) == b.capacity {
			b.timeline.next = 0
			b.timeline.full = true
		}
		return
	}
	b.timeline.samples[b.timeline.next] = sample
	b.timeline.next = (b.timeline.next + 1) % b.capacity
	b.timeline.full = true
}

func aggregateBucketStart(at time.Time) time.Time {
	return at.Truncate(aggregateBucketSize)
}

func (b *Buffer) addAggregateTimeline(sample timelineSample) {
	if b.aggregateCapacity == 0 {
		return
	}
	start := aggregateBucketStart(sample.sampledAt)
	gap := sample.gap
	if !b.lastTimeline.sampledAt.IsZero() && timelineBreak(b.lastTimeline, sample) {
		gap = true
	}
	b.lastTimeline = sample

	point := b.aggregateTimeline.current(start, b.aggregateCapacity)
	point.gap = point.gap || gap
}

func (b *Buffer) addAggregate(entity string, at time.Time, values map[string]float64) {
	if b.aggregateCapacity == 0 || entity == "" {
		return
	}
	r := b.aggregates[entity]
	if r == nil {
		r = &aggregateRing{}
		b.aggregates[entity] = r
	}
	point := r.current(aggregateBucketStart(at), b.aggregateCapacity)
	point.samples++
	for name, value := range values {
		metric, exists := point.values[name]
		if !exists {
			metric = aggregateMetric{latest: value, maximum: value, minimum: value}
		}
		metric.count++
		metric.sum += value
		metric.latest = value
		if value < metric.minimum {
			metric.minimum = value
		}
		if value > metric.maximum {
			metric.maximum = value
		}
		point.values[name] = metric
	}
	r.last = at
}

func (r *aggregateRing) current(start time.Time, capacity int) *aggregatePoint {
	if point := r.latest(); point != nil && point.start.Equal(start) {
		return point
	}
	point := aggregatePoint{start: start, values: make(map[string]aggregateMetric)}
	if len(r.points) < capacity {
		r.points = append(r.points, point)
		if len(r.points) == capacity {
			r.next = 0
			r.full = true
		}
		return &r.points[len(r.points)-1]
	}
	r.points[r.next] = point
	index := r.next
	r.next = (r.next + 1) % capacity
	r.full = true
	return &r.points[index]
}

func (r *aggregateRing) latest() *aggregatePoint {
	if len(r.points) == 0 {
		return nil
	}
	if !r.full {
		return &r.points[len(r.points)-1]
	}
	index := r.next - 1
	if index < 0 {
		index = len(r.points) - 1
	}
	return &r.points[index]
}

func (r *aggregateRing) ordered() []aggregatePoint {
	if !r.full {
		return append([]aggregatePoint(nil), r.points...)
	}
	out := append([]aggregatePoint(nil), r.points[r.next:]...)
	out = append(out, r.points[:r.next]...)
	return out
}

func (r *aggregateTimelineRing) current(start time.Time, capacity int) *aggregateTimelinePoint {
	if point := r.latest(); point != nil && point.start.Equal(start) {
		return point
	}
	point := aggregateTimelinePoint{start: start}
	if len(r.points) < capacity {
		r.points = append(r.points, point)
		if len(r.points) == capacity {
			r.next = 0
			r.full = true
		}
		return &r.points[len(r.points)-1]
	}
	r.points[r.next] = point
	index := r.next
	r.next = (r.next + 1) % capacity
	r.full = true
	return &r.points[index]
}

func (r *aggregateTimelineRing) latest() *aggregateTimelinePoint {
	if len(r.points) == 0 {
		return nil
	}
	if !r.full {
		return &r.points[len(r.points)-1]
	}
	index := r.next - 1
	if index < 0 {
		index = len(r.points) - 1
	}
	return &r.points[index]
}

func (r *aggregateTimelineRing) ordered() []aggregateTimelinePoint {
	if !r.full {
		return append([]aggregateTimelinePoint(nil), r.points...)
	}
	out := append([]aggregateTimelinePoint(nil), r.points[r.next:]...)
	out = append(out, r.points[:r.next]...)
	return out
}

func (b *Buffer) Query(entity string, metrics []string, window time.Duration, now time.Time) Series {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if window <= 0 || window > b.window {
		window = b.window
	}
	if window > b.rawWindow && b.aggregateCapacity > 0 {
		return b.queryAggregate(entity, metrics, window, now)
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

type aggregateQueryEntity struct {
	buckets int
	samples int
	values  map[string]aggregateMetric
}

type aggregateQueryBucket struct {
	start    time.Time
	buckets  int
	gap      bool
	entities map[string]*aggregateQueryEntity
}

func aggregateQueryResolution(window time.Duration) time.Duration {
	if window > 4*time.Hour {
		return longRollupSize
	}
	return aggregateBucketSize
}

func mergeAggregateMetric(current aggregateMetric, incoming aggregateMetric) aggregateMetric {
	if current.count == 0 {
		return incoming
	}
	current.count += incoming.count
	current.sum += incoming.sum
	current.latest = incoming.latest
	if incoming.minimum < current.minimum {
		current.minimum = incoming.minimum
	}
	if incoming.maximum > current.maximum {
		current.maximum = incoming.maximum
	}
	return current
}

// aggregateQueryBuckets returns epoch-aligned buckets ending at the next
// resolution boundary. Long-range queries therefore have a stable geometry:
// closed buckets never move, while only the newest partial bucket can change.
// The caller must hold b.mu for reading.
func (b *Buffer) aggregateQueryBuckets(entities []string, window time.Duration, now time.Time) []aggregateQueryBucket {
	resolution := aggregateQueryResolution(window)
	end := now.Truncate(resolution).Add(resolution)
	start := end.Add(-window)

	pointsByEntity := make(map[string]map[int64]aggregatePoint, len(entities))
	for _, entity := range entities {
		if _, exists := pointsByEntity[entity]; exists {
			continue
		}
		points := make(map[int64]aggregatePoint)
		if series := b.aggregates[entity]; series != nil {
			for _, point := range series.ordered() {
				points[point.start.UnixNano()] = point
			}
		}
		pointsByEntity[entity] = points
	}

	buckets := make([]aggregateQueryBucket, 0, int(window/resolution)+1)
	for _, timeline := range b.aggregateTimeline.ordered() {
		bucketStart := timeline.start.Truncate(resolution)
		if bucketStart.Before(start) || !bucketStart.Before(end) {
			continue
		}
		if len(buckets) == 0 || !buckets[len(buckets)-1].start.Equal(bucketStart) {
			buckets = append(buckets, aggregateQueryBucket{
				start:    bucketStart,
				entities: make(map[string]*aggregateQueryEntity),
			})
		}
		bucket := &buckets[len(buckets)-1]
		bucket.buckets++
		bucket.gap = bucket.gap || timeline.gap
		for _, entity := range entities {
			point, exists := pointsByEntity[entity][timeline.start.UnixNano()]
			if !exists {
				continue
			}
			value := bucket.entities[entity]
			if value == nil {
				value = &aggregateQueryEntity{values: make(map[string]aggregateMetric)}
				bucket.entities[entity] = value
			}
			value.buckets++
			value.samples += point.samples
			for name, metric := range point.values {
				value.values[name] = mergeAggregateMetric(value.values[name], metric)
			}
		}
	}
	return buckets
}

func aggregateValues(entity *aggregateQueryEntity, bucketCount int, metrics []string) map[string]float64 {
	values := make(map[string]float64)
	if entity == nil || entity.buckets != bucketCount || entity.samples == 0 {
		return values
	}
	if len(metrics) == 0 {
		for name, metric := range entity.values {
			if metric.count == entity.samples {
				values[name] = metric.sum / float64(metric.count)
			}
		}
		return values
	}
	for _, name := range metrics {
		metric, exists := entity.values[name]
		if exists && metric.count == entity.samples {
			values[name] = metric.sum / float64(metric.count)
		}
	}
	return values
}

func (b *Buffer) queryAggregate(entity string, metrics []string, window time.Duration, now time.Time) Series {
	result := Series{Entity: entity, Metrics: append([]string(nil), metrics...), Window: window.String(), Points: []Point{}}
	buckets := b.aggregateQueryBuckets([]string{entity}, window, now)
	first, last := -1, -1
	for index := range buckets {
		if buckets[index].entities[entity] != nil {
			if first < 0 {
				first = index
			}
			last = index
		}
	}
	if first < 0 {
		return result
	}
	for _, bucket := range buckets[first : last+1] {
		values := map[string]float64{}
		if !bucket.gap {
			values = aggregateValues(bucket.entities[entity], bucket.buckets, metrics)
		}
		result.Points = append(result.Points, Point{SampledAt: bucket.start, Values: values})
	}
	return result
}

// QueryAligned reads every requested entity under one buffer lock and emits
// only shared timestamps recorded by the collector. A series or metric missing
// from a row remains absent; values are never carried forward or interpolated.
func (b *Buffer) QueryAligned(descriptors []SeriesDescriptor, window time.Duration, maxPoints int, now time.Time) AlignedSeries {
	b.mu.RLock()
	if window <= 0 || window > b.window {
		window = b.window
	}
	if window > b.rawWindow && b.aggregateCapacity > 0 {
		result := b.queryAlignedAggregate(descriptors, window, now)
		b.mu.RUnlock()
		return LimitAligned(result, maxPoints)
	}
	timeline := b.timeline.ordered()
	entityPoints := make(map[string][]Point, len(descriptors))
	for _, descriptor := range descriptors {
		if _, exists := entityPoints[descriptor.Entity]; exists {
			continue
		}
		if entitySeries := b.series[descriptor.Entity]; entitySeries != nil {
			entityPoints[descriptor.Entity] = entitySeries.ordered()
		} else {
			entityPoints[descriptor.Entity] = nil
		}
	}
	b.mu.RUnlock()

	result := AlignedSeries{
		Window: window.String(),
		Series: cloneDescriptors(descriptors),
		Points: []AlignedPoint{},
	}
	cutoff := now.Add(-window)
	retained := make([]timelineSample, 0, len(timeline))
	for _, sample := range timeline {
		if !sample.sampledAt.Before(cutoff) && !sample.sampledAt.After(now) {
			retained = append(retained, sample)
		}
	}
	if len(retained) == 0 {
		return result
	}

	byEntity := make(map[string]map[int64]Point, len(descriptors))
	for _, descriptor := range descriptors {
		if _, exists := byEntity[descriptor.Entity]; exists {
			continue
		}
		points := make(map[int64]Point)
		for _, point := range entityPoints[descriptor.Entity] {
			if !point.SampledAt.Before(cutoff) && !point.SampledAt.After(now) {
				points[point.SampledAt.UnixNano()] = point
			}
		}
		byEntity[descriptor.Entity] = points
	}

	result.Points = make([]AlignedPoint, 0, len(retained))
	for _, sample := range retained {
		row := AlignedPoint{
			SampledAt: sample.sampledAt,
			Values:    make(map[string]map[string]float64),
		}
		if sample.gap {
			result.Points = append(result.Points, row)
			continue
		}
		for _, descriptor := range descriptors {
			point, exists := byEntity[descriptor.Entity][sample.sampledAt.UnixNano()]
			if !exists {
				continue
			}
			row.Values[descriptor.Key] = selectValues(point.Values, descriptor.Metrics)
		}
		result.Points = append(result.Points, row)
	}
	return limitAligned(result, retained, maxPoints)
}

// queryAlignedAggregate emits the same wire shape as raw aligned history, but
// values are deterministic means over compact long-range buckets. Missing
// values and collector gaps remain absent, so clients cannot accidentally
// bridge unavailable telemetry.
func (b *Buffer) queryAlignedAggregate(descriptors []SeriesDescriptor, window time.Duration, now time.Time) AlignedSeries {
	entities := make([]string, 0, len(descriptors))
	for _, descriptor := range descriptors {
		entities = append(entities, descriptor.Entity)
	}
	buckets := b.aggregateQueryBuckets(entities, window, now)
	result := AlignedSeries{
		Window: window.String(),
		Series: cloneDescriptors(descriptors),
		Points: make([]AlignedPoint, 0, len(buckets)),
	}
	for _, bucket := range buckets {
		row := AlignedPoint{SampledAt: bucket.start, Values: make(map[string]map[string]float64)}
		if !bucket.gap {
			for _, descriptor := range descriptors {
				values := aggregateValues(bucket.entities[descriptor.Entity], bucket.buckets, descriptor.Metrics)
				if len(values) > 0 {
					row.Values[descriptor.Key] = values
				}
			}
		}
		result.Points = append(result.Points, row)
	}
	return result
}

func cloneDescriptors(descriptors []SeriesDescriptor) []SeriesDescriptor {
	cloned := make([]SeriesDescriptor, len(descriptors))
	for index, descriptor := range descriptors {
		cloned[index] = descriptor
		cloned[index].Metrics = append([]string(nil), descriptor.Metrics...)
	}
	return cloned
}

func selectValues(values map[string]float64, metrics []string) map[string]float64 {
	selected := make(map[string]float64)
	if len(metrics) == 0 {
		for name, value := range values {
			selected[name] = value
		}
		return selected
	}
	for _, name := range metrics {
		if value, exists := values[name]; exists {
			selected[name] = value
		}
	}
	return selected
}

// LimitAligned applies the aligned shape-preserving limiter to an already
// assembled response. Buffer queries additionally preserve explicit collector
// gap records and cadence-aware time gaps.
func LimitAligned(series AlignedSeries, maxPoints int) AlignedSeries {
	samples := make([]timelineSample, len(series.Points))
	for index, point := range series.Points {
		samples[index].sampledAt = point.SampledAt
	}
	return limitAligned(series, samples, maxPoints)
}

type alignedSignal struct {
	key    string
	metric string
}

func limitAligned(series AlignedSeries, samples []timelineSample, maxPoints int) AlignedSeries {
	if maxPoints <= 0 || len(series.Points) <= maxPoints {
		return series
	}
	if maxPoints < 2 {
		series.Points = append([]AlignedPoint(nil), series.Points[:maxPoints]...)
		return series
	}

	selected := make([]bool, len(series.Points))
	selected[0], selected[len(selected)-1] = true, true
	selectedCount := 2
	signals := alignedSignals(series)

	// Missing-value edges and real collection gaps take precedence over shape
	// preservation. Keeping both sides prevents downsampling from healing an
	// outage into a continuous line.
	transitions := make([]bool, len(series.Points))
	for index := 1; index < len(series.Points); index++ {
		changed := timelineBreak(samples[index-1], samples[index])
		if !changed {
			for _, signal := range signals {
				_, previous := alignedValue(series.Points[index-1], signal)
				_, current := alignedValue(series.Points[index], signal)
				if previous != current {
					changed = true
					break
				}
			}
		}
		if changed {
			transitions[index-1], transitions[index] = true, true
		}
	}
	transitionIndexes := make([]int, 0)
	for index := 1; index < len(transitions)-1; index++ {
		if transitions[index] {
			transitionIndexes = append(transitionIndexes, index)
		}
	}
	selectEvenly(selected, transitionIndexes, maxPoints, &selectedCount)

	remaining := maxPoints - selectedCount
	interior := len(series.Points) - 2
	if remaining > 0 && interior > 0 && len(signals) > 0 {
		bucketCount := remaining / (2 * len(signals))
		if bucketCount > interior {
			bucketCount = interior
		}
		if bucketCount > 0 {
			for bucket := 0; bucket < bucketCount; bucket++ {
				start := 1 + interior*bucket/bucketCount
				end := 1 + interior*(bucket+1)/bucketCount
				for _, signal := range signals {
					minimum, maximum := alignedExtrema(series.Points, signal, start, end)
					selectIndex(selected, minimum, maxPoints, &selectedCount)
					selectIndex(selected, maximum, maxPoints, &selectedCount)
				}
			}
		} else {
			// With more signals than extrema capacity, sample the global extrema
			// candidate stream evenly so late descriptors are not starved.
			candidates := make([]int, 0, 2*len(signals))
			for _, signal := range signals {
				minimum, maximum := alignedExtrema(series.Points, signal, 1, len(series.Points)-1)
				if minimum >= 0 {
					candidates = append(candidates, minimum)
				}
				if maximum >= 0 {
					candidates = append(candidates, maximum)
				}
			}
			selectEvenly(selected, candidates, maxPoints, &selectedCount)
		}
	}

	if selectedCount < maxPoints {
		candidates := make([]int, 0, len(series.Points)-selectedCount)
		for index := 1; index < len(selected)-1; index++ {
			if !selected[index] {
				candidates = append(candidates, index)
			}
		}
		selectEvenly(selected, candidates, maxPoints, &selectedCount)
	}

	points := make([]AlignedPoint, 0, selectedCount)
	for index, keep := range selected {
		if keep {
			points = append(points, series.Points[index])
		}
	}
	series.Points = points
	return series
}

func alignedSignals(series AlignedSeries) []alignedSignal {
	signals := make([]alignedSignal, 0)
	for _, descriptor := range series.Series {
		metrics := append([]string(nil), descriptor.Metrics...)
		if len(metrics) == 0 {
			seen := make(map[string]struct{})
			for _, point := range series.Points {
				for metric := range point.Values[descriptor.Key] {
					seen[metric] = struct{}{}
				}
			}
			for metric := range seen {
				metrics = append(metrics, metric)
			}
			sort.Strings(metrics)
		}
		seen := make(map[string]struct{}, len(metrics))
		for _, metric := range metrics {
			if _, exists := seen[metric]; exists {
				continue
			}
			seen[metric] = struct{}{}
			signals = append(signals, alignedSignal{key: descriptor.Key, metric: metric})
		}
	}
	return signals
}

func alignedValue(point AlignedPoint, signal alignedSignal) (float64, bool) {
	values, exists := point.Values[signal.key]
	if !exists {
		return 0, false
	}
	value, exists := values[signal.metric]
	return value, exists
}

func alignedExtrema(points []AlignedPoint, signal alignedSignal, start, end int) (int, int) {
	minimum, maximum := -1, -1
	for index := start; index < end; index++ {
		value, exists := alignedValue(points[index], signal)
		if !exists {
			continue
		}
		if minimum < 0 {
			minimum, maximum = index, index
			continue
		}
		minimumValue, _ := alignedValue(points[minimum], signal)
		maximumValue, _ := alignedValue(points[maximum], signal)
		if value < minimumValue {
			minimum = index
		}
		if value > maximumValue {
			maximum = index
		}
	}
	return minimum, maximum
}

func timelineBreak(previous, current timelineSample) bool {
	if previous.gap || current.gap {
		return true
	}
	if previous.sequence > 0 && current.sequence > previous.sequence+1 {
		return true
	}
	expected := previous.interval
	if current.interval > expected {
		expected = current.interval
	}
	return expected > 0 && current.sampledAt.Sub(previous.sampledAt) > expected*3/2
}

func selectIndex(selected []bool, index, maxPoints int, selectedCount *int) {
	if index < 0 || index >= len(selected) || selected[index] || *selectedCount >= maxPoints {
		return
	}
	selected[index] = true
	*selectedCount++
}

func selectEvenly(selected []bool, candidates []int, maxPoints int, selectedCount *int) {
	remaining := maxPoints - *selectedCount
	if remaining <= 0 || len(candidates) == 0 {
		return
	}
	available := make([]int, 0, len(candidates))
	seen := make(map[int]struct{}, len(candidates))
	for _, index := range candidates {
		if index < 0 || index >= len(selected) || selected[index] {
			continue
		}
		if _, exists := seen[index]; exists {
			continue
		}
		seen[index] = struct{}{}
		available = append(available, index)
	}
	if len(available) <= remaining {
		for _, index := range available {
			selectIndex(selected, index, maxPoints, selectedCount)
		}
		return
	}
	for slot := 0; slot < remaining; slot++ {
		position := (2*slot + 1) * len(available) / (2 * remaining)
		selectIndex(selected, available[position], maxPoints, selectedCount)
	}
}

// EnsureCapacity grows every entity ring for a faster sampling interval. It
// never shrinks capacity, so changing cadence cannot discard retained points.
func (b *Buffer) EnsureCapacity(interval time.Duration) {
	if interval <= 0 {
		return
	}
	capacity := int(b.rawWindow/interval) + 2
	if capacity < 2 {
		capacity = 2
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	b.interval = interval
	if capacity <= b.capacity {
		return
	}
	for _, r := range b.series {
		ordered := r.ordered()
		r.points = ordered
		r.next = 0
		r.full = false
	}
	b.timeline.samples = b.timeline.ordered()
	b.timeline.next = 0
	b.timeline.full = false
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

func (r *timelineRing) ordered() []timelineSample {
	var out []timelineSample
	if !r.full {
		out = append([]timelineSample(nil), r.samples...)
	} else {
		out = append([]timelineSample(nil), r.samples[r.next:]...)
		out = append(out, r.samples[:r.next]...)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].sampledAt.Before(out[j].sampledAt) })
	return out
}

func (b *Buffer) Capacity() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.capacity
}

// AggregateCapacity is independent of collector cadence. It exposes the
// bounded long-range tier for deterministic capacity tests and diagnostics.
func (b *Buffer) AggregateCapacity() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.aggregateCapacity
}
