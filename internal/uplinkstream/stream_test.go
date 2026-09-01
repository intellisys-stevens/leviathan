package uplinkstream

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

func TestRunUsesNewestSequenceAtRequestedCadence(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	updates := make(chan model.Snapshot, 8)
	type sentSnapshot struct {
		sequence uint64
		at       time.Time
	}
	sent := make(chan sentSnapshot, 4)
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, updates, 50*time.Millisecond, func(_ context.Context, snapshot model.Snapshot) error {
			sent <- sentSnapshot{sequence: snapshot.Sequence, at: time.Now()}
			return nil
		}, io.Discard)
	}()

	updates <- model.Snapshot{Sequence: 1}
	first := <-sent
	if first.sequence != 1 {
		t.Fatalf("first sequence = %d, want 1", first.sequence)
	}
	updates <- model.Snapshot{Sequence: 1}
	updates <- model.Snapshot{Sequence: 2}
	updates <- model.Snapshot{Sequence: 3}
	second := <-sent
	if second.sequence != 3 {
		t.Fatalf("coalesced sequence = %d, want 3", second.sequence)
	}
	if elapsed := second.at.Sub(first.at); elapsed < 40*time.Millisecond {
		t.Fatalf("send cadence = %s, want approximately 50ms or slower", elapsed)
	}
	select {
	case duplicate := <-sent:
		t.Fatalf("duplicate sequence was sent: %+v", duplicate)
	case <-time.After(70 * time.Millisecond):
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("uplink stream did not stop after cancellation")
	}
}

func TestRunRejectsInvalidConfiguration(t *testing.T) {
	if err := Run(context.Background(), nil, time.Second, func(context.Context, model.Snapshot) error { return nil }, io.Discard); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("Run() error = %v, want ErrInvalidConfig", err)
	}
}
