package health

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/uplink"
)

func TestUplinkReceiptFreshnessUsesAttemptCompletion(t *testing.T) {
	at := time.Now()
	tracker := NewUplinkTracker(UplinkOptions{Enabled: true, Interval: 15 * time.Second, Now: func() time.Time { return at }})
	if got := tracker.UplinkObservation(at); got.State != Unknown || got.ObservedAt != nil || !strings.Contains(got.Message, "first upload") {
		t.Fatalf("initial link = %+v", got)
	}
	tracker.Observe(uplink.AttemptResult{Succeeded: true, SampledAt: at.Add(-time.Hour)})
	if tracker.acknowledged != at {
		t.Fatal("acknowledgement did not retain the local monotonic time")
	}
	if got := tracker.UplinkObservation(at.Add(45 * time.Second)); got.State != Operational || got.LastAcknowledgedAt == nil || !got.LastAcknowledgedAt.Equal(at) {
		t.Fatalf("fresh receipt = %+v", got)
	}
	if got := tracker.UplinkObservation(at.Add(45*time.Second + time.Nanosecond)); got.State != Unavailable || !strings.Contains(got.Message, "expired") {
		t.Fatalf("receipt did not expire without a new attempt: %+v", got)
	}
	if got := tracker.UplinkObservation(at.Add(-time.Second)); got.State != Unavailable {
		t.Fatalf("future acknowledgement was accepted: %+v", got)
	}
	for _, test := range []struct{ interval, lifetime time.Duration }{
		{time.Second, 30 * time.Second},
		{time.Minute, 3 * time.Minute},
		{0, 45 * time.Second},
	} {
		link := NewUplinkTracker(UplinkOptions{Enabled: true, Interval: test.interval, Now: func() time.Time { return at }})
		link.Observe(uplink.AttemptResult{Succeeded: true})
		if link.UplinkObservation(at.Add(test.lifetime)).State != Operational || link.UplinkObservation(at.Add(test.lifetime+time.Nanosecond)).State != Unavailable {
			t.Fatalf("wrong freshness interval: %+v", test)
		}
	}
}

func TestUplinkFailuresAndRecovery(t *testing.T) {
	at := testTime()
	tracker := NewUplinkTracker(UplinkOptions{Enabled: true, Now: func() time.Time { return at }})
	tracker.Observe(uplink.AttemptResult{Retryable: true, Err: uplink.ErrRequestFailed, NextAttemptIn: 5 * time.Second})
	if got := tracker.UplinkObservation(at); got.State != Unavailable || got.RetryAt == nil || got.LastAcknowledgedAt != nil {
		t.Fatalf("first connection failure = %+v", got)
	}
	tracker.Observe(uplink.AttemptResult{Succeeded: true})
	at = at.Add(10 * time.Second)
	tracker.Observe(uplink.AttemptResult{Retryable: true, Err: uplink.ErrInvalidReceipt, NextAttemptIn: 10 * time.Second})
	if got := tracker.UplinkObservation(at); got.State != Degraded || got.Message != "Upload acknowledgement could not be validated." {
		t.Fatalf("fresh receipt plus retry = %+v", got)
	}
	if got := tracker.UplinkObservation(at.Add(36 * time.Second)); got.State != Unavailable || got.RetryAt != nil {
		t.Fatalf("expired receipt plus retry = %+v", got)
	}
	tracker.Observe(uplink.AttemptResult{Err: uplink.ErrUnexpectedStatus, Retryable: false})
	if got := tracker.UplinkObservation(at); got.State != Unavailable || got.Message != "Yggdrasil rejected the upload." {
		t.Fatalf("authentication / non-retryable rejection = %+v", got)
	}
	tracker.Observe(uplink.AttemptResult{Succeeded: true})
	if got := tracker.UplinkObservation(at); got.State != Operational || got.Message != "" || got.RetryAt != nil {
		t.Fatalf("recovered receipt = %+v", got)
	}
	tracker.Observe(uplink.AttemptResult{Succeeded: true, Err: errors.New("https://secret.example/token?key=private")})
	data, _ := json.Marshal(tracker.UplinkObservation(at))
	if bytes.Contains(data, []byte("private")) || bytes.Contains(data, []byte("secret.example")) || tracker.UplinkObservation(at).State != Unavailable {
		t.Fatalf("invalid success or unsanitized failure = %s", data)
	}
	disabled := NewUplinkTracker(UplinkOptions{Now: func() time.Time { return at }})
	disabled.Observe(uplink.AttemptResult{Succeeded: true})
	if got := disabled.UplinkObservation(at); got.State != Unknown || got.LastAcknowledgedAt != nil || got.Message != "Uploader is not configured." {
		t.Fatalf("disabled uploader = %+v", got)
	}
}

func TestUplinkJournalRestartAndRollbackCompatibility(t *testing.T) {
	at := testTime()
	directory := privateDirectory(t)
	source := &testSource{available(at)}
	tracker := NewUplinkTracker(UplinkOptions{Enabled: true, Now: func() time.Time { return at }})
	tracker.Observe(uplink.AttemptResult{Succeeded: true})
	options := Options{Enabled: true, Directory: directory, Uplink: tracker, Now: func() time.Time { return at }}
	r := New(source, options)
	r.Record(at)
	r.Record(at.Add(time.Second))
	at = at.Add(time.Minute)
	source.observation = available(at)
	r.Record(at) // Receipt expired even though the collector is fresh.
	if got := r.Status().Days[RetentionDays-1].Components["uplink"]; got != (Counts{Operational: 1, Unavailable: 1, Unknown: 2}) {
		t.Fatalf("minute freshness = %+v", got)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	legacyPath := filepath.Join(directory, "2026-09-05.ndjson")
	legacyBytes, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range bytes.Split(bytes.TrimSpace(legacyBytes), []byte{'\n'}) {
		var value record
		if err := json.Unmarshal(line, &value); err != nil || !validRecord(value) || value.Components["uplink"] != "" {
			t.Fatalf("legacy schema changed: %s", line)
		}
	}
	path := filepath.Join(directory, "uplink-2026-09-05.ndjson")
	saved, err := os.ReadFile(path)
	if err != nil || bytes.Count(saved, []byte{'\n'}) != 2 {
		t.Fatalf("sidecar = %q, %v", saved, err)
	}
	for _, field := range []string{"message", "acknowledg", "retry", "token", "url"} {
		if bytes.Contains(saved, []byte(field)) {
			t.Fatalf("sidecar saved non-state data: %s", saved)
		}
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("sidecar permissions = %o", info.Mode().Perm())
	}
	// The old reader ignores sidecars, acquires the same ownership lock, and
	// can still append its own version-one records during a rollback.
	old := New(source, Options{Enabled: true, Directory: directory, Now: func() time.Time { return at }})
	if !old.Status().Persistence.Saving || len(old.Status().Components) != 2 {
		t.Fatal("legacy reader rejected new history")
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(after, saved) {
		t.Fatal("rollback altered a sidecar")
	}
	at = at.Add(5 * time.Minute)
	source.observation = available(at)
	tracker = NewUplinkTracker(UplinkOptions{Enabled: true, Now: func() time.Time { return at }})
	options.Uplink = tracker
	r = New(source, options)
	defer r.Close()
	r.Record(at)
	if got := r.Status().Days[RetentionDays-1].Components["uplink"]; got != (Counts{Operational: 1, Unavailable: 1, Unknown: 7}) {
		t.Fatalf("restart filled unknown minutes: %+v", got)
	}
	if after, _ := os.ReadFile(legacyPath); !bytes.HasPrefix(after, legacyBytes) {
		t.Fatal("legacy prefix changed on upgrade")
	}
}

func TestUplinkWriterCannotBlockLegacyWritesAndIsBounded(t *testing.T) {
	at := testTime()
	source := &testSource{available(at)}
	tracker := NewUplinkTracker(UplinkOptions{Enabled: true, Now: func() time.Time { return at }})
	tracker.Observe(uplink.AttemptResult{Succeeded: true})
	r := New(source, Options{Enabled: true, Directory: privateDirectory(t), Uplink: tracker, Now: func() time.Time { return at }})
	entered, release := make(chan struct{}), make(chan struct{})
	first := true
	r.uplinkWriter.journal.io.syncFile = func(*os.File) error {
		if first {
			first = false
			close(entered)
			<-release
		}
		return nil
	}
	defer r.Close()
	defer close(release)
	r.Record(at)
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("sidecar did not start flushing")
	}
	finished := make(chan struct{})
	go func() {
		for index := 1; index <= uplinkQueueSize+2; index++ {
			r.Record(at.Add(time.Duration(index) * time.Minute))
		}
		_ = r.Status()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("sidecar blocked minute observation or status")
	}
	if got := r.Status().Persistence; got.Saving || !strings.Contains(got.Message, "queue is full") {
		t.Fatalf("bounded queue failure not visible: %+v", got)
	}
	if !r.persistence.Saving || len(r.records) != uplinkQueueSize+3 {
		t.Fatal("sidecar failure disabled legacy observations")
	}
}

func TestUplinkJournalFailureDoesNotDisableLegacyPersistence(t *testing.T) {
	for _, kind := range []string{"sync", "future_version", "symlink", "lock"} {
		t.Run(kind, func(t *testing.T) {
			at := testTime()
			directory := privateDirectory(t)
			path := filepath.Join(directory, "uplink-2026-09-05.ndjson")
			before := []byte("{\"version\":2}\n{\"partial\"")
			switch kind {
			case "future_version":
				if err := os.WriteFile(path, before, 0o600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				target := filepath.Join(t.TempDir(), "private")
				if err := os.WriteFile(target, before, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			case "lock":
				first := New(nil, Options{Enabled: true, Directory: directory})
				defer first.Close()
			}
			tracker := NewUplinkTracker(UplinkOptions{Enabled: true, Now: func() time.Time { return at }})
			tracker.Observe(uplink.AttemptResult{Succeeded: true})
			r := New(&testSource{available(at)}, Options{Enabled: true, Directory: directory, Uplink: tracker, Now: func() time.Time { return at }})
			defer r.Close()
			if kind == "sync" {
				r.uplinkWriter.journal.io.syncFile = func(*os.File) error { return errors.New("disk full") }
			}
			r.Record(at)
			deadline := time.Now().Add(time.Second)
			for r.Status().Persistence.Saving && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			if got := r.Status(); got.Persistence.Saving || got.Persistence.Message == "" || got.Days[RetentionDays-1].Components["uplink"].Operational != 1 {
				t.Fatalf("live sidecar failure = %+v", got)
			}
			if kind != "lock" && !r.persistence.Saving {
				t.Fatal("sidecar failure disabled legacy saving")
			}
			if kind == "future_version" || kind == "symlink" {
				if after, _ := os.ReadFile(path); !bytes.Equal(after, before) {
					t.Fatal("unsafe / future sidecar was changed")
				}
			}
		})
	}
}

func TestUplinkJournalRecoversTruncationCorruptionAndPreservesGaps(t *testing.T) {
	at := testTime()
	directory := privateDirectory(t)
	entry := uplinkRecord{Version: 1, ObservedAt: at, Minute: at.Unix() / 60, State: Operational}
	data, _ := json.Marshal(entry)
	data = append(data, []byte("\nbroken row\n{\"incomplete\"")...)
	path := filepath.Join(directory, "uplink-2026-09-05.ndjson")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	expired := filepath.Join(directory, "uplink-"+at.AddDate(0, 0, -(RetentionDays+1)).Format(time.DateOnly)+".ndjson")
	if err := os.WriteFile(expired, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	unrelated := filepath.Join(directory, "uplink-notes.ndjson")
	if err := os.WriteFile(unrelated, []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	tracker := NewUplinkTracker(UplinkOptions{Enabled: true, Now: func() time.Time { return at }})
	r := New(nil, Options{Enabled: true, Directory: directory, Uplink: tracker, Now: func() time.Time { return at }})
	defer r.Close()
	if got := r.Status(); !got.Persistence.Saving || got.Persistence.Message == "" || got.Days[RetentionDays-1].Components["uplink"] != (Counts{Operational: 1, Unknown: 2}) {
		t.Fatalf("recovery = %+v", got)
	}
	if _, err := os.Stat(expired); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expired sidecar retained: %v", err)
	}
	if after, _ := os.ReadFile(unrelated); string(after) != "preserve" {
		t.Fatal("unrelated file was changed")
	}
	r.Record(at)
	r.Record(at.Add(-time.Minute))
	r.Record(at.Add(time.Minute))
	if got := r.Report(at.Add(time.Minute)).Days[RetentionDays-1].Components["uplink"]; got != (Counts{Operational: 1, Unknown: 3}) {
		t.Fatalf("clock change duplicated observations: %+v", got)
	}
}

func TestUplinkMemoryOnlyRecordsDoNotCreateFiles(t *testing.T) {
	at := testTime()
	directory := filepath.Join(t.TempDir(), "no-files")
	r := New(nil, Options{Directory: directory, Uplink: NewUplinkTracker(UplinkOptions{}), Now: func() time.Time { return at }})
	r.Record(at)
	if got := r.Status(); got.Persistence.Enabled || got.Days[RetentionDays-1].Components["uplink"].Unknown != 3 {
		t.Fatalf("memory-only = %+v", got)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(directory); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("fixture created sidecar storage")
	}
}
