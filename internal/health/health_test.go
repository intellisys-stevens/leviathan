package health

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

type testSource struct{ observation Observation }

func (s *testSource) HealthObservation() Observation { return s.observation }

func available(at time.Time) Observation {
	return Observation{
		System:   ProviderComponent("system", "Host telemetry", model.ProviderState{Available: true, Status: model.StatusAvailable}, at),
		GPU:      ProviderComponent("gpu", "GPU telemetry", model.ProviderState{Status: model.StatusUnsupported}, at),
		Interval: time.Second,
	}
}

func testTime() time.Time { return time.Date(2026, 9, 5, 0, 2, 10, 0, time.UTC) }

func privateDirectory(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestMonitorRuntimePreservesMonotonicClock(t *testing.T) {
	at := time.Now()
	r := New(nil, Options{Now: func() time.Time { return at }})
	// Exact equality includes the monotonic reading; calling UTC or Round on
	// the retained start would silently discard it and reintroduce wall time.
	if r.startedAt != at {
		t.Fatal("monitor start lost its monotonic clock reading")
	}
	report := r.Report(at.Add(125 * time.Second))
	if report.MonitorUptimeSeconds == nil || *report.MonitorUptimeSeconds != 125 {
		t.Fatalf("monitor runtime = %v", report.MonitorUptimeSeconds)
	}
	if report.MonitorStartedAt != at.UTC() {
		t.Fatalf("serialized start is not UTC: %v", report.MonitorStartedAt)
	}
	if got := r.Report(at.Add(-time.Second)).MonitorUptimeSeconds; got != nil {
		t.Fatalf("negative runtime was exposed: %v", *got)
	}
}

func TestNinetyDayRetentionLoadsExistingSchemasAndPrunesOnlyExpiredDates(t *testing.T) {
	at := testTime()
	directory := privateDirectory(t)
	for index := range RetentionDays + 1 {
		observed := at.AddDate(0, 0, -index)
		legacy := record{Version: 1, ObservedAt: observed, Minute: observed.Unix() / 60, Components: map[string]State{"system": Operational, "gpu": Unsupported}}
		link := uplinkRecord{Version: 1, ObservedAt: observed, Minute: observed.Unix() / 60, State: Operational}
		for name, entry := range map[string]any{observed.Format(time.DateOnly) + ".ndjson": legacy, "uplink-" + observed.Format(time.DateOnly) + ".ndjson": link} {
			data, err := json.Marshal(entry)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(directory, name), append(data, '\n'), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	r := New(nil, Options{Enabled: true, Directory: directory, Uplink: NewUplinkTracker(UplinkOptions{}), Now: func() time.Time { return at }})
	defer r.Close()
	report := r.Status()
	if RetentionDays != 90 || report.RetentionDays != 90 || len(report.Days) != 90 || report.Days[0].Date != "2026-06-08" || report.Days[89].Date != "2026-09-05" {
		t.Fatalf("wrong ninety-day window: retention=%d days=%d first=%s last=%s", report.RetentionDays, len(report.Days), report.Days[0].Date, report.Days[len(report.Days)-1].Date)
	}
	if !report.Persistence.Saving {
		t.Fatalf("expanded journal set was rejected: %+v", report.Persistence)
	}
	expected, healthy := 0, 0
	for _, day := range report.Days {
		expected += day.ExpectedSamples
		healthy += day.Components["system"].Operational
		if day.Components["system"].Operational != 1 || day.Components["uplink"].Operational != 1 || day.Components["gpu"].Unsupported != 1 {
			t.Fatalf("saved schema was not retained: %+v", day)
		}
	}
	if expected != 89*1440+3 || healthy != 90 {
		t.Fatalf("coverage denominator includes the wrong dates: healthy=%d expected=%d", healthy, expected)
	}
	for _, prefix := range []string{"", "uplink-"} {
		if _, err := os.Stat(filepath.Join(directory, prefix+"2026-06-07.ndjson")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("expired history was not pruned: %v", err)
		}
		if _, err := os.Stat(filepath.Join(directory, prefix+"2026-06-08.ndjson")); err != nil {
			t.Fatalf("oldest included date was not retained: %v", err)
		}
	}
}

func TestJournalSurvivesRestartAndPreservesUnknownMinutes(t *testing.T) {
	at := testTime()
	directory := filepath.Join(t.TempDir(), "history")
	source := &testSource{available(at)}
	options := Options{Enabled: true, Directory: directory, Now: func() time.Time { return at }}
	r := New(source, options)
	r.Record(at)
	if !r.Status().Persistence.Saving {
		t.Fatalf("persistence = %+v", r.Status().Persistence)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	at = at.Add(5 * time.Minute)
	source.observation = available(at)
	r = New(source, options)
	defer r.Close()
	r.Record(at)
	r.Record(at.Add(time.Second)) // A repeated observation must not inflate coverage.
	report := r.Status()
	day := report.Days[RetentionDays-1]
	if day.ExpectedSamples != 8 || day.Components["system"] != (Counts{Operational: 2, Unknown: 6}) || day.Components["gpu"] != (Counts{Unsupported: 2, Unknown: 6}) {
		t.Fatalf("restart counts = %+v", day)
	}
	if !report.MonitorStartedAt.Equal(at) || len(report.Days) != RetentionDays {
		t.Fatalf("report = %+v", report)
	}
	data, err := os.ReadFile(filepath.Join(directory, "2026-09-05.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Count(data, []byte{'\n'}) != 2 {
		t.Fatalf("journal rows = %q", data)
	}
	for _, path := range []string{directory, filepath.Join(directory, "writer.lock"), filepath.Join(directory, "2026-09-05.ndjson")} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("not private: %s mode=%o", path, info.Mode().Perm())
		}
	}
}

func TestIndependentFreshnessAndAttributionScope(t *testing.T) {
	at := testTime()
	observation := available(at)
	old := at.Add(-time.Minute)
	observation.GPU = ProviderComponent("gpu", "GPU telemetry", model.ProviderState{Available: true, Status: model.StatusAvailable}, old)
	observation.Attribution = &Component{ID: "attribution", Label: "Workspace attribution", State: Degraded, ObservedAt: &at}
	source := &testSource{observation}
	r := New(source, Options{Attribution: true, Now: func() time.Time { return at }})
	r.Record(at)
	report := r.Status()
	if report.Components[0].State != Operational || report.Components[1].State != Unknown || report.Components[2].State != Degraded {
		t.Fatalf("independent freshness = %+v", report.Components)
	}
	if got := report.Days[RetentionDays-1].Components["attribution"]; got.Degraded != 1 || got.Unknown != 2 {
		t.Fatalf("attribution counts = %+v", got)
	}
	disabled := New(source, Options{Now: func() time.Time { return at }})
	if len(disabled.Status().Components) != 2 {
		t.Fatal("unconfigured attribution should not be shown")
	}
}

func TestPersistenceFailureLeavesLiveObservationsAvailable(t *testing.T) {
	at := testTime()
	for _, kind := range []string{"locked", "unwritable", "symlink", "sync"} {
		t.Run(kind, func(t *testing.T) {
			directory := filepath.Join(t.TempDir(), "health")
			var first *Recorder
			if kind == "locked" {
				first = New(nil, Options{Enabled: true, Directory: directory, Now: func() time.Time { return at }})
				defer first.Close()
			}
			if kind == "unwritable" {
				if err := os.WriteFile(directory, []byte("file"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if kind == "symlink" {
				if err := os.Symlink(t.TempDir(), directory); err != nil {
					t.Fatal(err)
				}
			}
			r := New(&testSource{available(at)}, Options{Enabled: true, Directory: directory, Now: func() time.Time { return at }})
			defer r.Close()
			if kind == "sync" {
				if r.journal == nil {
					t.Fatal(r.persistence.Message)
				}
				r.journal.syncFile = func(*os.File) error { return errors.New("disk full") }
			}
			r.Record(at)
			report := r.Status()
			if report.Persistence.Saving || report.Persistence.Message == "" || report.Components[0].State != Operational || report.Days[RetentionDays-1].Components["system"].Operational != 1 {
				t.Fatalf("failure must not stop live monitoring: %+v", report)
			}
		})
	}
}

func TestRecoveryPreservesValidRowsAndUnknownVersions(t *testing.T) {
	at := testTime()
	for _, kind := range []string{"truncated", "corrupt", "future_version"} {
		t.Run(kind, func(t *testing.T) {
			directory := privateDirectory(t)
			entry := record{Version: 1, ObservedAt: at, Minute: at.Unix() / 60, Components: map[string]State{"system": Operational, "gpu": Unsupported}}
			if kind == "future_version" {
				entry.Version = 2
			}
			data, _ := json.Marshal(entry)
			data = append(data, '\n')
			switch kind {
			case "truncated", "future_version":
				data = append(data, []byte(`{"version":1`)...)
			case "corrupt":
				data = append(data, []byte("broken row\n")...)
			}
			path := filepath.Join(directory, "2026-09-05.ndjson")
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			r := New(&testSource{available(at)}, Options{Enabled: true, Directory: directory, Now: func() time.Time { return at }})
			defer r.Close()
			report := r.Status()
			if kind == "future_version" {
				if report.Persistence.Saving {
					t.Fatal("unknown version was accepted")
				}
				after, _ := os.ReadFile(path)
				if !bytes.Equal(after, data) {
					t.Fatal("unknown version file was mutated")
				}
			} else if !report.Persistence.Saving || report.Persistence.Message == "" || report.Days[RetentionDays-1].Components["system"].Operational != 1 {
				t.Fatalf("recovery = %+v", report)
			}
		})
	}
}

func TestRetentionAndClockGapsDoNotFabricateObservations(t *testing.T) {
	at := testTime()
	directory := privateDirectory(t)
	old := at.AddDate(0, 0, -(RetentionDays + 1))
	entry := record{Version: 1, ObservedAt: old, Minute: old.Unix() / 60, Components: map[string]State{"system": Operational, "gpu": Unsupported}}
	data, _ := json.Marshal(entry)
	expired := filepath.Join(directory, old.Format(time.DateOnly)+".ndjson")
	if err := os.WriteFile(expired, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(directory, "notes.txt")
	if err := os.WriteFile(other, []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	source := &testSource{available(at)}
	r := New(source, Options{Enabled: true, Directory: directory, Now: func() time.Time { return at }})
	defer r.Close()
	if _, err := os.Stat(expired); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expired file retained: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatal("unrelated file removed")
	}
	r.Record(at)
	r.Record(at.Add(-time.Hour))
	source.observation = available(at.Add(time.Hour))
	r.Record(at.Add(time.Hour))
	report := r.Report(at.Add(time.Hour))
	counts := report.Days[RetentionDays-1].Components["system"]
	if counts.Operational != 2 || counts.Unknown != 61 {
		t.Fatalf("clock gap counts = %+v", counts)
	}
	if !strings.Contains(report.Persistence.Message, "Clock changed") {
		t.Fatal("clock discontinuity missing")
	}
}

func TestDisabledRecorderDoesNotCreateFilesAndStopsPromptly(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "not-created")
	r := New(nil, Options{Directory: directory})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.Run(ctx); close(done) }()
	var readers sync.WaitGroup
	for range 3 {
		readers.Go(func() {
			for range 10 {
				_ = r.Status()
			}
		})
	}
	readers.Wait()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("recorder did not stop")
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(directory); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("disabled recorder wrote files")
	}
}

func TestJournalRejectsLinkedFilesWithoutTouchingTarget(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "public"} {
		t.Run(kind, func(t *testing.T) {
			directory := privateDirectory(t)
			target := filepath.Join(t.TempDir(), "target")
			if err := os.WriteFile(target, []byte("private target"), 0o600); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(directory, "writer.lock")
			switch kind {
			case "symlink":
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			case "hardlink":
				if err := os.Link(target, path); err != nil {
					t.Fatal(err)
				}
			case "public":
				if err := os.WriteFile(path, nil, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			r := New(nil, Options{Enabled: true, Directory: directory})
			defer r.Close()
			if r.Status().Persistence.Saving {
				t.Fatal("unsafe journal accepted")
			}
			data, _ := os.ReadFile(target)
			if string(data) != "private target" {
				t.Fatal("target changed")
			}
		})
	}
}

func TestStatusRemainsResponsiveDuringJournalSync(t *testing.T) {
	at := testTime()
	r := New(&testSource{available(at)}, Options{Enabled: true, Directory: filepath.Join(t.TempDir(), "health"), Now: func() time.Time { return at }})
	defer r.Close()
	if r.journal == nil {
		t.Fatal(r.persistence.Message)
	}
	syncStarted := make(chan struct{}, 1)
	release := make(chan struct{})
	r.journal.syncFile = func(*os.File) error {
		select {
		case syncStarted <- struct{}{}:
		default:
		}
		<-release
		return nil
	}
	defer close(release)
	done := make(chan struct{})
	go func() { r.Record(at); close(done) }()
	<-syncStarted
	response := make(chan Report, 1)
	go func() { response <- r.Status() }()
	select {
	case report := <-response:
		if report.Components[0].State != Operational {
			t.Fatal("live health unavailable")
		}
	case <-time.After(time.Second):
		t.Fatal("disk sync blocked status reads")
	}
}

func TestRestartAfterBackwardClockChangeDoesNotOverwriteJournal(t *testing.T) {
	at := testTime().Add(time.Hour)
	directory := filepath.Join(t.TempDir(), "health")
	source := &testSource{available(at)}
	options := Options{Enabled: true, Directory: directory, Now: func() time.Time { return at }}
	r := New(source, options)
	r.Record(at)
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	at = at.Add(-time.Hour)
	source.observation = available(at)
	r = New(source, options)
	defer r.Close()
	r.Record(at)
	if report := r.Status(); report.Days[RetentionDays-1].Components["system"].Operational != 1 || report.Persistence.Message == "" {
		t.Fatal("current recording was suppressed or a future observation inflated coverage")
	}
	at = at.Add(2 * time.Hour)
	source.observation = available(at)
	r.Record(at)
	data, err := os.ReadFile(filepath.Join(directory, "2026-09-05.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Count(data, []byte{'\n'}) != 3 {
		t.Fatalf("clock restart overwrote/duplicated rows: %q", data)
	}
}

func TestGPUHealthReflectsUnreadableDevicesButIgnoresOptionalProfiling(t *testing.T) {
	for _, test := range []struct {
		name, code string
		status     model.MetricStatus
		devices    int
		want       State
	}{
		{"all handles failed", "gpu_handle", model.StatusError, 0, Unavailable},
		{"one handle failed", "gpu_handle", model.StatusPermissionDenied, 1, Degraded},
		{"MIG enumeration failed", "mig_enumeration", model.StatusError, 1, Degraded},
		{"unsupported profiling", "gpm_profile_paused", model.StatusUnsupported, 1, Operational},
		{"unsupported MIG mode", "mig_mode", model.StatusUnsupported, 1, Operational},
		{"unrelated host warning", "system_storage", model.StatusError, 1, Operational},
	} {
		t.Run(test.name, func(t *testing.T) {
			snapshot := model.Snapshot{SampledAt: testTime(), Capabilities: model.Capabilities{NVML: model.ProviderState{Available: true, Status: model.StatusAvailable}}, GPUs: make([]model.GPU, test.devices), Diagnostics: []model.Diagnostic{{Code: test.code, Status: test.status}}}
			if got := GPUComponent(snapshot).State; got != test.want {
				t.Fatalf("state=%s want %s", got, test.want)
			}
		})
	}
}
