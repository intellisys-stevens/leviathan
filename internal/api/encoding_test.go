package api

import (
	"bytes"
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/provider/fake"
	"github.com/intellisys-stevens/leviathan/model"
)

func TestSnapshotEncodingRetainsLatestImmutableProjection(t *testing.T) {
	var cache snapshotEncoder
	snapshot, _ := fake.New().Sample(context.Background(), time.Now().UTC())
	snapshot.Sequence = 2
	first, err := cache.encode(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	expected := bytes.Clone(first)
	var readers sync.WaitGroup
	for range 16 {
		readers.Add(1)
		go func() {
			defer readers.Done()
			got, err := cache.encode(snapshot)
			if err != nil || !bytes.Equal(got, expected) {
				t.Errorf("shared projection changed: %v", err)
			}
		}()
	}
	readers.Wait()
	older := snapshot
	older.Sequence = 1
	if _, err := cache.encode(older); err != nil {
		t.Fatal(err)
	}
	if cache.sequence != 2 || !bytes.Equal(first, expected) {
		t.Fatal("older reader replaced or mutated current cache")
	}
	newer := snapshot
	newer.Sequence = 3
	newer.Processes = nil
	got, err := cache.encode(newer)
	if err != nil {
		t.Fatal(err)
	}
	var decoded model.Snapshot
	if err = json.Unmarshal(got, &decoded); err != nil || decoded.Processes == nil {
		t.Fatalf("normalization lost: %v", err)
	}
	if !bytes.Equal(first, expected) {
		t.Fatal("previous SSE client's bytes were mutated")
	}
}

func BenchmarkSnapshotEncoding(b *testing.B) {
	snapshot, _ := fake.New().Sample(context.Background(), time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	for _, shared := range []bool{false, true} {
		name := "unshared"
		if shared {
			name = "shared"
		}
		b.Run(name, func(b *testing.B) {
			var cache snapshotEncoder
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; b.Loop(); i++ {
				snapshot.Sequence = uint64(i/16 + 1)
				var err error
				if shared {
					_, err = cache.encode(snapshot)
				} else {
					_, err = json.Marshal(model.NormalizeSnapshot(snapshot))
				}
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
