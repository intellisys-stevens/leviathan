package uplink

import (
	"context"
	"errors"
	"io"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

func TestRunnerUsesLatestOnlyAndRetriesExactLogicalAttempt(t *testing.T) {
	source := &fakeSnapshotSource{snapshots: make(chan model.Snapshot, 8)}
	first := projectionSnapshot()
	second := projectionSnapshot()
	second.SampledAt = first.SampledAt.Add(time.Second)
	source.snapshots <- first
	sender := &blockingSender{calls: make(chan Envelope, 8), results: make(chan error, 8)}
	attempts := make(chan AttemptResult, 8)
	runner, err := NewRunner(source, sender, RunnerOptions{
		Interval: 10 * time.Second, Backoff: 5 * time.Second, MaximumBackoff: 20 * time.Second,
		StreamID: testStreamID, Random: zeroReader{},
		OnAttempt: func(result AttemptResult) { attempts <- result },
	})
	if err != nil {
		t.Fatal(err)
	}
	timerCreated := make(chan *fakeRunnerTimer, 1)
	runner.newTimer = func(delay time.Duration) runnerTimer {
		timer := &fakeRunnerTimer{channel: make(chan time.Time, 1), resets: make(chan time.Duration, 8), initial: delay}
		timerCreated <- timer
		return timer
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	timer := receive(t, timerCreated)
	if timer.initial != 0 {
		t.Fatalf("startup delay = %s, want 0", timer.initial)
	}

	timer.Fire()
	firstAttempt := receive(t, sender.calls)
	if firstAttempt.Sequence != 1 || !firstAttempt.SampledAt.Equal(first.SampledAt) {
		t.Fatalf("first attempt = %+v", firstAttempt)
	}
	// A newer sample arrives while the request is in flight. The failed old
	// observation must be discarded rather than queued ahead of it.
	source.snapshots <- second
	sender.results <- requestFailure(ErrRequestFailed, true, 7*time.Second)
	if delay := receive(t, timer.resets); delay != 7*time.Second {
		t.Fatalf("first retry delay = %s, want Retry-After 7s", delay)
	}
	result := receive(t, attempts)
	if result.Sequence != 1 || !result.Retryable || result.Succeeded {
		t.Fatalf("first result = %+v", result)
	}

	timer.Fire()
	secondAttempt := receive(t, sender.calls)
	if secondAttempt.Sequence != 2 || !secondAttempt.SampledAt.Equal(second.SampledAt) {
		t.Fatalf("replacement attempt = %+v", secondAttempt)
	}
	sender.results <- requestFailure(ErrRequestFailed, true, 0)
	if delay := receive(t, timer.resets); delay != 9*time.Second {
		t.Fatalf("second retry delay = %s, want jittered exponential 9s", delay)
	}
	_ = receive(t, attempts)

	timer.Fire()
	retry := receive(t, sender.calls)
	if !reflect.DeepEqual(retry, secondAttempt) {
		t.Fatalf("retry changed the logical attempt:\nfirst %+v\nretry %+v", secondAttempt, retry)
	}
	sender.results <- nil
	if delay := receive(t, timer.resets); delay != 9*time.Second {
		t.Fatalf("success delay = %s, want jittered interval 9s", delay)
	}
	result = receive(t, attempts)
	if result.Sequence != 2 || !result.Succeeded || result.Err != nil {
		t.Fatalf("success result = %+v", result)
	}

	cancel()
	if err := receive(t, done); err != nil {
		t.Fatalf("Run() = %v", err)
	}
	if source.unsubscribed.Load() != 1 || !timer.stopped.Load() {
		t.Fatalf("cleanup: unsubscribe=%d timer stopped=%v", source.unsubscribed.Load(), timer.stopped.Load())
	}
}

func TestRunnerCapsBackoffAndHonorsRetryAfterWithinCap(t *testing.T) {
	runner := &Runner{backoff: 5 * time.Second, maximumBackoff: 20 * time.Second, random: zeroReader{}}
	if got := runner.retryDelay(1, 0); got != 4500*time.Millisecond {
		t.Fatalf("first backoff = %s", got)
	}
	if got := runner.retryDelay(20, 0); got != 18*time.Second {
		t.Fatalf("capped jittered backoff = %s", got)
	}
	if got := runner.retryDelay(20, time.Hour); got != 20*time.Second {
		t.Fatalf("Retry-After cap = %s", got)
	}
}

func TestRunnerReturnsWhenSourceClosesAndCanRunOnlyOnce(t *testing.T) {
	source := &fakeSnapshotSource{snapshots: make(chan model.Snapshot)}
	sender := &blockingSender{calls: make(chan Envelope), results: make(chan error)}
	runner, err := NewRunner(source, sender, RunnerOptions{StreamID: testStreamID})
	if err != nil {
		t.Fatal(err)
	}
	close(source.snapshots)
	if err := runner.Run(context.Background()); !errors.Is(err, ErrSnapshotSourceEnd) {
		t.Fatalf("Run() = %v", err)
	}
	if err := runner.Run(context.Background()); !errors.Is(err, ErrRunnerAlreadyUsed) {
		t.Fatalf("second Run() = %v", err)
	}
}

func TestNewRunnerValidatesConfigurationAndGeneratesStream(t *testing.T) {
	source := &fakeSnapshotSource{snapshots: make(chan model.Snapshot)}
	sender := &blockingSender{calls: make(chan Envelope), results: make(chan error)}
	runner, err := NewRunner(source, sender, RunnerOptions{Random: zeroReader{}})
	if err != nil || runner.StreamID() != testStreamID || runner.interval != DefaultInterval {
		t.Fatalf("runner = %+v, err = %v", runner, err)
	}
	tests := []RunnerOptions{
		{Interval: time.Millisecond, StreamID: testStreamID},
		{Interval: MaximumInterval + time.Second, StreamID: testStreamID},
		{Backoff: 10 * time.Second, MaximumBackoff: 5 * time.Second, StreamID: testStreamID},
		{StreamID: "invalid"},
	}
	for _, options := range tests {
		if _, err := NewRunner(source, sender, options); err == nil {
			t.Fatalf("accepted options %+v", options)
		}
	}
	if _, err := NewRunner(nil, sender, RunnerOptions{}); !errors.Is(err, ErrRunnerConfig) {
		t.Fatalf("nil source error = %v", err)
	}
}

type fakeSnapshotSource struct {
	snapshots    chan model.Snapshot
	unsubscribed atomic.Int32
}

func (source *fakeSnapshotSource) Subscribe() (<-chan model.Snapshot, func()) {
	return source.snapshots, func() { source.unsubscribed.Add(1) }
}

type blockingSender struct {
	calls   chan Envelope
	results chan error
}

func (sender *blockingSender) Send(ctx context.Context, envelope Envelope) (Receipt, error) {
	select {
	case sender.calls <- envelope:
	case <-ctx.Done():
		return Receipt{}, ctx.Err()
	}
	select {
	case err := <-sender.results:
		if err != nil {
			return Receipt{}, err
		}
		return Receipt{Status: "accepted", StreamID: envelope.StreamID, Sequence: envelope.Sequence}, nil
	case <-ctx.Done():
		return Receipt{}, ctx.Err()
	}
}

type fakeRunnerTimer struct {
	channel chan time.Time
	resets  chan time.Duration
	initial time.Duration
	stopped atomic.Bool
}

func (timer *fakeRunnerTimer) Channel() <-chan time.Time { return timer.channel }
func (timer *fakeRunnerTimer) Reset(delay time.Duration) bool {
	timer.resets <- delay
	return true
}
func (timer *fakeRunnerTimer) Stop() bool {
	timer.stopped.Store(true)
	return true
}
func (timer *fakeRunnerTimer) Fire() { timer.channel <- time.Now() }

type zeroReader struct{}

func (zeroReader) Read(document []byte) (int, error) {
	clear(document)
	return len(document), nil
}

func receive[T any](t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case value := <-channel:
		return value
	case <-time.After(2 * time.Second):
		var zero T
		t.Fatal("timed out waiting for test event")
		return zero
	}
}

var _ io.Reader = zeroReader{}
