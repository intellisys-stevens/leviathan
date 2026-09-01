// Package uplinkstream schedules newly collected snapshots for outbound Uplink
// delivery without retaining a local telemetry queue.
package uplinkstream

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

var ErrInvalidConfig = errors.New("uplink stream configuration is invalid")

type SendFunc func(context.Context, model.Snapshot) error

// Run sends only newly sampled snapshots, at no more than the requested
// cadence. The collector subscription is size one, so collection or transport
// delays replace superseded pending snapshots instead of building a queue.
func Run(ctx context.Context, updates <-chan model.Snapshot, interval time.Duration, send SendFunc, stderr io.Writer) error {
	if ctx == nil || updates == nil || interval <= 0 || send == nil || stderr == nil {
		return ErrInvalidConfig
	}
	var timer *time.Timer
	var readyAt <-chan time.Time
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()

	ready := true
	failed := false
	connected := false
	var lastSequence uint64
	var pending *model.Snapshot
	for {
		if ready && pending != nil {
		drainPending:
			for {
				select {
				case snapshot, open := <-updates:
					if !open {
						if ctx.Err() != nil {
							return nil
						}
						return errors.New("uplink collector stopped")
					}
					if snapshot.Sequence > lastSequence && snapshot.Sequence > pending.Sequence {
						copy := snapshot
						pending = &copy
					}
				default:
					break drainPending
				}
			}
			snapshot := *pending
			pending = nil
			lastSequence = snapshot.Sequence
			if timer == nil {
				timer = time.NewTimer(interval)
			} else {
				timer.Reset(interval)
			}
			readyAt = timer.C
			ready = false

			sendErr := send(ctx, snapshot)
			if sendErr != nil {
				if ctx.Err() != nil {
					return nil
				}
				if !failed {
					fmt.Fprintln(stderr, "Leviathan uplink is unavailable; continuing without a local queue.")
				}
				failed = true
			} else {
				if failed {
					fmt.Fprintln(stderr, "Leviathan uplink recovered.")
				} else if !connected {
					fmt.Fprintln(stderr, "Leviathan uplink connected.")
				}
				failed = false
				connected = true
			}
			continue
		}

		select {
		case <-ctx.Done():
			return nil
		case snapshot, open := <-updates:
			if !open {
				if ctx.Err() != nil {
					return nil
				}
				return errors.New("uplink collector stopped")
			}
			if snapshot.Sequence <= lastSequence || pending != nil && snapshot.Sequence <= pending.Sequence {
				continue
			}
			copy := snapshot
			pending = &copy
		case <-readyAt:
			ready = true
			readyAt = nil
		}
	}
}
