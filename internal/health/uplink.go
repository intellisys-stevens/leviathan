package health

import (
	"errors"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/uplink"
)

// UplinkSource recomputes acknowledgement freshness at the observation time.
// It is separate from collector health: uploading and sampling fail independently.
type UplinkSource interface {
	UplinkObservation(time.Time) Component
}

type UplinkOptions struct {
	Enabled  bool
	Interval time.Duration
	Now      func() time.Time
}

// UplinkTracker retains only the latest attempt and acknowledgement. Timestamps
// preserve their monotonic readings until they are copied into API responses.
// Payload timestamps do not establish a connection to Yggdrasil.
type UplinkTracker struct {
	mu           sync.RWMutex
	options      UplinkOptions
	maximumAge   time.Duration
	attemptedAt  time.Time
	acknowledged time.Time
	retryAt      time.Time
	failed       bool
	retryable    bool
	message      string
}

func NewUplinkTracker(options UplinkOptions) *UplinkTracker {
	if options.Interval <= 0 {
		options.Interval = uplink.DefaultInterval
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &UplinkTracker{options: options, maximumAge: max(3*options.Interval, 30*time.Second)}
}

// Observe is called only after the existing uploader validates the receipt or
// reports a failed attempt. No request URL, credentials, response, or arbitrary
// error text crosses this boundary.
func (t *UplinkTracker) Observe(result uplink.AttemptResult) {
	if !t.options.Enabled {
		return
	}
	at := t.options.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.attemptedAt = at
	t.failed = !result.Succeeded || result.Err != nil
	t.retryable = result.Retryable
	t.retryAt = time.Time{}
	if result.NextAttemptIn > 0 && t.failed {
		t.retryAt = at.Add(result.NextAttemptIn)
	}
	if !t.failed {
		t.acknowledged = at
		t.message = ""
		return
	}
	t.message = uplinkFailureMessage(result)
}

func uplinkFailureMessage(result uplink.AttemptResult) string {
	switch {
	case errors.Is(result.Err, uplink.ErrCredentialInsecure), errors.Is(result.Err, uplink.ErrCredentialInvalid), errors.Is(result.Err, uplink.ErrCredentialRead):
		return "Upload credentials could not be used."
	case errors.Is(result.Err, uplink.ErrInvalidReceipt), errors.Is(result.Err, uplink.ErrReceiptMismatch):
		return "Upload acknowledgement could not be validated."
	case errors.Is(result.Err, uplink.ErrUnexpectedStatus) && !result.Retryable:
		return "Yggdrasil rejected the upload."
	case errors.Is(result.Err, uplink.ErrRequestFailed):
		return "Yggdrasil could not be reached."
	case result.Retryable:
		return "Upload failed; retry scheduled."
	default:
		return "Upload failed."
	}
}

func (t *UplinkTracker) UplinkObservation(at time.Time) Component {
	t.mu.RLock()
	defer t.mu.RUnlock()
	component := Component{ID: "uplink", Label: "Yggdrasil connection", State: Unknown}
	if !t.options.Enabled {
		component.Message = "Uploader is not configured."
		return component
	}
	if t.attemptedAt.IsZero() {
		component.Message = "Waiting for the first upload acknowledgement."
		return component
	}
	observed := t.attemptedAt.UTC()
	component.ObservedAt = &observed
	if !t.acknowledged.IsZero() {
		acknowledged := t.acknowledged.UTC()
		component.LastAcknowledgedAt = &acknowledged
	}
	if remaining := t.retryAt.Sub(at); !t.retryAt.IsZero() && remaining > 0 {
		retryAt := at.UTC().Add(remaining)
		component.RetryAt = &retryAt
	}
	age := at.Sub(t.acknowledged)
	fresh := !t.acknowledged.IsZero() && age >= 0 && age <= t.maximumAge
	if !fresh {
		component.State = Unavailable
		component.Message = t.message
		if component.Message == "" {
			component.Message = "Upload acknowledgement expired."
		}
		return component
	}
	if t.failed {
		component.State = Unavailable
		if t.retryable {
			component.State = Degraded
		}
		component.Message = t.message
		return component
	}
	component.State = Operational
	return component
}
