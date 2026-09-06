// Package health retains local, discrete telemetry health observations. It does
// not measure external service availability or infer uptime between samples.
package health

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

const RetentionDays = 90

type State string

const (
	Operational State = "operational"
	Degraded    State = "degraded"
	Unavailable State = "unavailable"
	Unsupported State = "unsupported"
	Unknown     State = "unknown"
)

type Component struct {
	ID                 string     `json:"id"`
	Label              string     `json:"label"`
	State              State      `json:"state"`
	ObservedAt         *time.Time `json:"observedAt,omitempty"`
	Message            string     `json:"message,omitempty"`
	LastAcknowledgedAt *time.Time `json:"lastAcknowledgedAt,omitempty"`
	RetryAt            *time.Time `json:"retryAt,omitempty"`
}

// Observation is internal collector state. Each component has an independent
// timestamp so a healthy system worker cannot hide a blocked GPU worker.
type Observation struct {
	System      Component
	GPU         Component
	Attribution *Component
	Interval    time.Duration
}

type Source interface{ HealthObservation() Observation }

type Counts struct {
	Operational int `json:"operational"`
	Degraded    int `json:"degraded"`
	Unavailable int `json:"unavailable"`
	Unsupported int `json:"unsupported"`
	Unknown     int `json:"unknown"`
}

type Day struct {
	Date            string            `json:"date"`
	ExpectedSamples int               `json:"expectedSamples"`
	Components      map[string]Counts `json:"components"`
}

type Persistence struct {
	Enabled bool   `json:"enabled"`
	Saving  bool   `json:"saving"`
	Message string `json:"message,omitempty"`
}

type Report struct {
	SampledAt            time.Time   `json:"sampledAt"`
	MonitorStartedAt     time.Time   `json:"monitorStartedAt"`
	MonitorUptimeSeconds *float64    `json:"monitorUptimeSeconds,omitempty"`
	RetentionDays        int         `json:"retentionDays"`
	Persistence          Persistence `json:"persistence"`
	Components           []Component `json:"components"`
	Days                 []Day       `json:"days"`
}

type Options struct {
	Enabled     bool
	Directory   string
	Attribution bool
	Uplink      UplinkSource
	// Now is a deterministic clock seam. Production preserves Go's monotonic
	// reading until the point at which a timestamp is serialized as UTC.
	Now func() time.Time
}

type record struct {
	Version    int              `json:"version"`
	ObservedAt time.Time        `json:"observedAt"`
	Minute     int64            `json:"minute"`
	Components map[string]State `json:"components"`
}

type Recorder struct {
	mu                sync.RWMutex
	writeMu           sync.Mutex
	source            Source
	options           Options
	startedAt         time.Time
	lastTick          time.Time
	records           map[int64]record
	persistence       Persistence
	journal           *journal
	uplinkRecords     map[int64]uplinkRecord
	uplinkPersistence Persistence
	uplinkWriter      *uplinkWriter
	closed            bool
}

// New always returns a functioning in-memory recorder, including when opening
// persistent storage fails. That failure is visible in every status response.
func New(source Source, options Options) *Recorder {
	if options.Now == nil {
		options.Now = time.Now
	}
	now := options.Now()
	r := &Recorder{source: source, options: options, startedAt: now, records: make(map[int64]record), uplinkRecords: make(map[int64]uplinkRecord), persistence: Persistence{Enabled: options.Enabled}, uplinkPersistence: Persistence{Enabled: options.Enabled && options.Uplink != nil}}
	if options.Enabled {
		j, entries, warning, err := openJournal(options.Directory, now.UTC())
		if err != nil {
			r.persistence.Message = "History not being saved: " + err.Error()
		} else {
			r.journal, r.persistence.Saving, r.persistence.Message = j, true, warning
			for _, entry := range entries {
				r.records[entry.Minute] = entry
			}
			if options.Uplink != nil {
				uj, uplinkEntries, warning, err := openUplinkJournal(j, now.UTC())
				if err != nil {
					r.uplinkPersistence.Message = "Yggdrasil history not being saved: " + err.Error()
				} else {
					r.uplinkPersistence.Saving, r.uplinkPersistence.Message = true, warning
					for _, entry := range uplinkEntries {
						r.uplinkRecords[entry.Minute] = entry
					}
					r.uplinkWriter = newUplinkWriter(uj, func(saving bool, message string) {
						r.mu.Lock()
						defer r.mu.Unlock()
						// A delayed cleanup warning must not replace an earlier
						// write/queue failure or claim saving has resumed.
						if !saving || r.uplinkPersistence.Saving {
							r.uplinkPersistence.Saving, r.uplinkPersistence.Message = saving, message
						}
					})
				}
			}
		}
	}
	return r
}

func (r *Recorder) Run(ctx context.Context) {
	r.Record(r.options.Now())
	for {
		now := r.options.Now()
		delay := now.Truncate(time.Minute).Add(time.Minute).Sub(now)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			r.Record(r.options.Now())
		}
	}
}

func (r *Recorder) current(now time.Time) []Component {
	observation := Observation{}
	if r.source != nil {
		observation = r.source.HealthObservation()
	}
	components := []Component{observation.System, observation.GPU}
	components[0].ID, components[0].Label = "system", "Host telemetry"
	components[1].ID, components[1].Label = "gpu", "GPU telemetry"
	if r.options.Attribution {
		component := Component{ID: "attribution", Label: "Workspace attribution", State: Unknown}
		if observation.Attribution != nil {
			component = *observation.Attribution
		}
		components = append(components, component)
	}
	maximumAge := max(3*observation.Interval, 5*time.Second)
	for i := range components {
		component := &components[i]
		if component.State == "" {
			component.State = Unknown
		}
		if component.ObservedAt == nil || now.Sub(*component.ObservedAt) > maximumAge || component.ObservedAt.After(now.Add(time.Second)) {
			component.State = Unknown
		}
	}
	// Uplink owns its acknowledgement freshness rule. Collector intervals and
	// snapshot timestamps must not expire or refresh this independent signal.
	if r.options.Uplink != nil {
		components = append(components, r.options.Uplink.UplinkObservation(now))
	}
	return components
}

// Record keeps exactly one actual observation per UTC minute. Missed minutes
// stay absent, and a restart or backward clock change cannot overwrite one.
func (r *Recorder) Record(at time.Time) {
	components := r.current(at)
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	discontinuous := false
	if !r.lastTick.IsZero() {
		wall := at.UTC().Sub(r.lastTick.UTC())
		elapsed := at.Sub(r.lastTick)
		difference := wall - elapsed
		discontinuous = wall < 0 || difference > 5*time.Second || difference < -5*time.Second
	}
	r.lastTick = at
	if discontinuous {
		if !r.persistence.Enabled || r.persistence.Saving {
			r.persistence.Message = "Clock changed; the observation gap remains unknown."
		}
		r.mu.Unlock()
		return
	}
	minute := at.Unix() / 60
	_, legacyExists := r.records[minute]
	entry := record{Version: 1, ObservedAt: at.UTC(), Minute: minute, Components: make(map[string]State, len(components))}
	var nextUplink *uplinkRecord
	for _, component := range components {
		if component.ID == "uplink" {
			if _, exists := r.uplinkRecords[minute]; !exists {
				value := uplinkRecord{Version: 1, ObservedAt: at.UTC(), Minute: minute, State: component.State}
				r.uplinkRecords[minute] = value
				nextUplink = &value
			}
			continue
		}
		entry.Components[component.ID] = component.State
	}
	if !legacyExists {
		r.records[minute] = entry
	}
	cutoff := firstDay(at).Unix() / 60
	for key := range r.records {
		if key < cutoff {
			delete(r.records, key)
		}
	}
	for key := range r.uplinkRecords {
		if key < cutoff {
			delete(r.uplinkRecords, key)
		}
	}
	saving := !legacyExists && r.journal != nil && r.persistence.Saving
	r.mu.Unlock()
	if nextUplink != nil && r.uplinkWriter != nil {
		r.uplinkWriter.enqueue(*nextUplink)
	}
	// Status reads and the collector remain responsive during disk I/O. Only
	// the recorder's single writer and shutdown wait for the durability barrier.
	if saving {
		if err := r.journal.append(entry); err != nil {
			r.mu.Lock()
			r.persistence.Saving = false
			r.persistence.Message = "History not being saved: " + err.Error()
			r.mu.Unlock()
		} else if err := r.journal.prune(firstDay(at)); err != nil {
			r.mu.Lock()
			r.persistence.Message = "History retention cleanup failed: " + err.Error()
			r.mu.Unlock()
		}
	}
}

func firstDay(at time.Time) time.Time {
	at = at.UTC()
	return time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -(RetentionDays - 1))
}

func (r *Recorder) Status() Report { return r.Report(r.options.Now()) }

func (r *Recorder) Report(at time.Time) Report {
	components := r.current(at)
	r.mu.RLock()
	defer r.mu.RUnlock()
	persistence := r.persistence
	if r.uplinkPersistence.Enabled {
		persistence.Saving = persistence.Saving && r.uplinkPersistence.Saving
		persistence.Message = strings.TrimSpace(strings.Join([]string{persistence.Message, r.uplinkPersistence.Message}, " "))
	}
	result := Report{SampledAt: at.UTC(), MonitorStartedAt: r.startedAt.UTC(), RetentionDays: RetentionDays, Persistence: persistence, Components: components, Days: make([]Day, 0, RetentionDays)}
	// Sub uses Go's monotonic readings before either timestamp is serialized,
	// so wall-clock corrections cannot change the process's elapsed runtime.
	if uptime := at.Sub(r.startedAt).Seconds(); uptime >= 0 {
		result.MonitorUptimeSeconds = &uptime
	}
	start := firstDay(at)
	currentMinute := at.Unix() / 60
	for index := range RetentionDays {
		day := start.AddDate(0, 0, index)
		firstMinute := day.Unix() / 60
		endMinute := min(firstMinute+24*60, currentMinute+1)
		expected := max(0, int(endMinute-firstMinute))
		bucket := Day{Date: day.Format(time.DateOnly), ExpectedSamples: expected, Components: make(map[string]Counts, len(components))}
		for _, component := range components {
			counts := Counts{Unknown: expected}
			for minute := firstMinute; minute < endMinute; minute++ {
				entry := r.records[minute]
				observed, state := entry.ObservedAt, entry.Components[component.ID]
				if component.ID == "uplink" {
					linkEntry := r.uplinkRecords[minute]
					observed, state = linkEntry.ObservedAt, linkEntry.State
				}
				if observed.After(at) {
					continue
				}
				switch state {
				case Operational:
					counts.Operational++
					counts.Unknown--
				case Degraded:
					counts.Degraded++
					counts.Unknown--
				case Unavailable:
					counts.Unavailable++
					counts.Unknown--
				case Unsupported:
					counts.Unsupported++
					counts.Unknown--
				}
			}
			bucket.Components[component.ID] = counts
		}
		result.Days = append(result.Days, bucket)
	}
	return result
}

func (r *Recorder) Close() error {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	r.mu.Unlock()
	var errs []error
	if r.uplinkWriter != nil {
		errs = append(errs, r.uplinkWriter.shutdown())
	}
	if r.journal != nil {
		errs = append(errs, r.journal.close())
	}
	return errors.Join(errs...)
}

func ProviderComponent(id, label string, provider model.ProviderState, at time.Time) Component {
	state := Unknown
	switch provider.Status {
	case model.StatusUnsupported:
		state = Unsupported
	case model.StatusAvailable, model.StatusEstimated:
		if provider.Available {
			state = Operational
		} else {
			state = Unavailable
		}
	case model.StatusStale:
		if provider.Available {
			state = Degraded
		} else {
			state = Unavailable
		}
	case model.StatusPermissionDenied, model.StatusError:
		state = Unavailable
	}
	utc := at.UTC()
	return Component{ID: id, Label: label, State: state, ObservedAt: &utc}
}

// GPUComponent distinguishes a working NVML library from readable GPU
// telemetry. Unsupported optional profiling never makes a healthy GPU fail.
func GPUComponent(snapshot model.Snapshot) Component {
	component := ProviderComponent("gpu", "GPU telemetry", snapshot.Capabilities.NVML, snapshot.SampledAt)
	if component.State != Operational {
		return component
	}
	for _, diagnostic := range snapshot.Diagnostics {
		if diagnostic.Status != model.StatusError && diagnostic.Status != model.StatusPermissionDenied && diagnostic.Status != model.StatusStale {
			continue
		}
		switch diagnostic.Code {
		case "gpu_handle", "gpu_uuid", "mig_mode", "mig_enumeration", "mig_handle", "mig_identity":
			component.State = Degraded
			if diagnostic.Code == "gpu_handle" && len(snapshot.GPUs) == 0 {
				component.State = Unavailable
				return component
			}
		}
	}
	return component
}
