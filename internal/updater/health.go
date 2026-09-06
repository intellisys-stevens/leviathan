package updater

import "time"

// samplingHealth verifies sustained progress, not just a newer final timestamp.
// It is shared by setup, updates and rollback. All times are observer-local;
// no timestamps or elapsed time supplied by the agent can start the window early.
type samplingHealth struct {
	since, lastSample, lastAdvance, lastObserved time.Time
	cadence                                      time.Duration
	advances                                     int
}

func (h *samplingHealth) reset() { *h = samplingHealth{} }

func samplingGap(cadence time.Duration) (time.Duration, bool) {
	if cadence < 250*time.Millisecond || cadence > time.Minute {
		return 0, false
	}
	return max(5*time.Second, 3*cadence), true
}

func (h *samplingHealth) observe(now time.Time, sample Probe, valid bool, window time.Duration) bool {
	gap, cadenceValid := samplingGap(sample.SamplingInterval)
	if !valid || !cadenceValid || sample.SampledAt.IsZero() ||
		sample.SampledAt.After(now.Add(5*time.Second)) || now.Sub(sample.SampledAt) > gap {
		h.reset()
		return false
	}
	if !h.since.IsZero() && (sample.SamplingInterval != h.cadence ||
		sample.SampledAt.Before(h.lastSample) || now.Before(h.lastObserved) ||
		now.Sub(h.lastAdvance) > gap || now.Sub(h.lastObserved) > gap) {
		// A late jump cannot erase a stall or inherit the old healthy window.
		h.reset()
	}
	if h.since.IsZero() {
		h.since, h.lastSample, h.lastAdvance = now, sample.SampledAt, now
		h.cadence = sample.SamplingInterval
	} else if sample.SampledAt.After(h.lastSample) {
		h.lastSample, h.lastAdvance = sample.SampledAt, now
		h.advances++
	}
	h.lastObserved = now
	return now.Sub(h.since) >= window && h.advances >= 2
}
