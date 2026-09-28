package api

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/model"
)

// snapshotEncoder retains at most one immutable encoding. HTTP and SSE readers
// share it; an older slow reader never evicts the current sequence's bytes.
// Sequence zero (unversioned sources) is deliberately never cached.
type snapshotEncoder struct {
	mu        sync.Mutex
	sequence  uint64
	sampledAt time.Time
	data      []byte
}

const maxCachedSnapshotBytes = 4 << 20

func (c *snapshotEncoder) encode(snapshot model.Snapshot) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if snapshot.Sequence != 0 && snapshot.Sequence == c.sequence && snapshot.SampledAt.Equal(c.sampledAt) && c.data != nil {
		return c.data, nil
	}
	data, err := json.Marshal(model.NormalizeSnapshot(snapshot))
	if err == nil && snapshot.Sequence != 0 && snapshot.Sequence >= c.sequence && len(data) <= maxCachedSnapshotBytes {
		c.sequence = snapshot.Sequence
		c.sampledAt = snapshot.SampledAt
		c.data = data
	}
	return data, err
}
