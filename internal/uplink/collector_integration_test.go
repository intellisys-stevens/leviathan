package uplink_test

import (
	"github.com/intellisys-stevens/leviathan/internal/collector"
	"github.com/intellisys-stevens/leviathan/internal/uplink"
)

// This compile-time assertion is the integration boundary: serve passes its
// existing Engine to the uplink runner. Uplink has no provider or collector
// constructor and therefore cannot accidentally open NVML a second time.
var _ uplink.SnapshotSource = (*collector.Engine)(nil)
