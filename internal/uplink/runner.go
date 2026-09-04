package uplink

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

const (
	DefaultInterval       = 15 * time.Second
	DefaultBackoff        = 5 * time.Second
	DefaultMaximumBackoff = 5 * time.Minute
	DefaultJitterFraction = 0.10
	MinimumInterval       = time.Second
	MaximumInterval       = time.Hour
)

var (
	ErrRunnerConfig      = errors.New("uplink runner configuration is invalid")
	ErrSnapshotSourceEnd = errors.New("uplink snapshot source closed unexpectedly")
	ErrSequenceExhausted = errors.New("uplink sequence is exhausted")
	ErrRunnerAlreadyUsed = errors.New("uplink runner has already been used")
)

// SnapshotSource is satisfied by collector.Engine. The runner subscribes to
// that already-running engine and can neither create nor control a collector.
type SnapshotSource interface {
	Subscribe() (<-chan model.Snapshot, func())
}

type Sender interface {
	Send(context.Context, Envelope) (Receipt, error)
}

type RunnerOptions struct {
	Interval       time.Duration
	Backoff        time.Duration
	MaximumBackoff time.Duration
	BuildInfo      model.BuildInfo
	// StreamID is normally empty and generated from crypto/rand. It exists so
	// deterministic integration tests can supply one canonical ID.
	StreamID string
	// Random is a test seam used for stream generation and scheduling jitter.
	// Production callers leave it nil.
	Random    io.Reader
	OnAttempt func(AttemptResult)
}

type AttemptResult struct {
	StreamID      string
	Sequence      uint64
	SampledAt     time.Time
	Succeeded     bool
	Retryable     bool
	NextAttemptIn time.Duration
	Err           error
}

type Runner struct {
	source         SnapshotSource
	sender         Sender
	interval       time.Duration
	backoff        time.Duration
	maximumBackoff time.Duration
	buildInfo      model.BuildInfo
	streamID       string
	random         io.Reader
	onAttempt      func(AttemptResult)
	newTimer       func(time.Duration) runnerTimer

	mu   sync.Mutex
	used bool
}

func NewRunner(source SnapshotSource, sender Sender, options RunnerOptions) (*Runner, error) {
	if source == nil || sender == nil {
		return nil, ErrRunnerConfig
	}
	interval := options.Interval
	if interval == 0 {
		interval = DefaultInterval
	}
	backoff := options.Backoff
	if backoff == 0 {
		backoff = DefaultBackoff
	}
	maximumBackoff := options.MaximumBackoff
	if maximumBackoff == 0 {
		maximumBackoff = DefaultMaximumBackoff
	}
	if interval < MinimumInterval || interval > MaximumInterval || backoff <= 0 || maximumBackoff < backoff || maximumBackoff > time.Hour {
		return nil, ErrRunnerConfig
	}
	randomReader := options.Random
	if randomReader == nil {
		randomReader = rand.Reader
	}
	streamID := options.StreamID
	if streamID == "" {
		var err error
		streamID, err = newStreamID(randomReader)
		if err != nil {
			return nil, err
		}
	} else if !validStreamID(streamID) {
		return nil, ErrInvalidStreamID
	}
	return &Runner{
		source: source, sender: sender, interval: interval, backoff: backoff, maximumBackoff: maximumBackoff,
		buildInfo: options.BuildInfo, streamID: streamID, random: randomReader, onAttempt: options.OnAttempt,
		newTimer: func(delay time.Duration) runnerTimer { return &standardTimer{Timer: time.NewTimer(delay)} },
	}, nil
}

func (runner *Runner) StreamID() string {
	if runner == nil {
		return ""
	}
	return runner.streamID
}

// Run owns one non-overlapping upload loop. It keeps at most the latest source
// snapshot plus one encoded logical attempt in memory; there is no disk queue.
func (runner *Runner) Run(ctx context.Context) error {
	if runner == nil || ctx == nil || runner.source == nil || runner.sender == nil || runner.newTimer == nil {
		return ErrRunnerConfig
	}
	runner.mu.Lock()
	if runner.used {
		runner.mu.Unlock()
		return ErrRunnerAlreadyUsed
	}
	runner.used = true
	runner.mu.Unlock()

	snapshots, unsubscribe := runner.source.Subscribe()
	if snapshots == nil || unsubscribe == nil {
		return ErrRunnerConfig
	}
	defer unsubscribe()

	var latest model.Snapshot
	haveLatest := false
	var revision uint64
	if closed := drainSnapshots(snapshots, &latest, &haveLatest, &revision); closed {
		return ErrSnapshotSourceEnd
	}
	timer := runner.newTimer(runner.randomDelay(runner.interval))
	defer timer.Stop()

	var pending Envelope
	havePending := false
	var pendingRevision uint64
	var sequence uint64
	consecutiveFailures := 0

	for {
		select {
		case <-ctx.Done():
			return nil
		case snapshot, ok := <-snapshots:
			if !ok {
				return ErrSnapshotSourceEnd
			}
			latest, haveLatest = snapshot, true
			revision++
			if havePending && pendingRevision != revision {
				havePending = false
			}
		case <-timer.Channel():
			if !haveLatest {
				timer.Reset(runner.jitter(runner.interval))
				continue
			}
			if !havePending || pendingRevision != revision {
				if sequence == math.MaxUint64 {
					return ErrSequenceExhausted
				}
				sequence++
				projected, err := Project(latest, runner.buildInfo, runner.streamID, sequence)
				if err != nil {
					delay := runner.jitter(runner.interval)
					runner.report(AttemptResult{StreamID: runner.streamID, Sequence: sequence, SampledAt: latest.SampledAt, NextAttemptIn: delay, Err: err})
					timer.Reset(delay)
					continue
				}
				pending, havePending, pendingRevision = projected, true, revision
			}

			_, sendErr := runner.sender.Send(ctx, pending)
			if ctx.Err() != nil {
				return nil
			}
			if closed := drainSnapshots(snapshots, &latest, &haveLatest, &revision); closed {
				return ErrSnapshotSourceEnd
			}
			if pendingRevision != revision {
				havePending = false
			}

			if sendErr == nil {
				consecutiveFailures = 0
				havePending = false
				delay := runner.jitter(runner.interval)
				runner.report(AttemptResult{StreamID: pending.StreamID, Sequence: pending.Sequence, SampledAt: pending.SampledAt, Succeeded: true, NextAttemptIn: delay})
				timer.Reset(delay)
				continue
			}

			retryable := IsRetryable(sendErr)
			delay := runner.jitter(runner.interval)
			if retryable {
				consecutiveFailures++
				delay = runner.retryDelay(consecutiveFailures, RetryAfter(sendErr))
			} else {
				consecutiveFailures = 0
			}
			runner.report(AttemptResult{
				StreamID: pending.StreamID, Sequence: pending.Sequence, SampledAt: pending.SampledAt,
				Retryable: retryable, NextAttemptIn: delay, Err: sendErr,
			})
			timer.Reset(delay)
		}
	}
}

func (runner *Runner) report(result AttemptResult) {
	if runner.onAttempt != nil {
		runner.onAttempt(result)
	}
}

func (runner *Runner) retryDelay(failures int, retryAfter time.Duration) time.Duration {
	delay := runner.backoff
	for count := 1; count < failures && delay < runner.maximumBackoff; count++ {
		if delay > runner.maximumBackoff/2 {
			delay = runner.maximumBackoff
			break
		}
		delay *= 2
	}
	delay = min(delay, runner.maximumBackoff)
	delay = runner.jitter(delay)
	if retryAfter > delay {
		delay = retryAfter
	}
	return min(delay, runner.maximumBackoff)
}

func (runner *Runner) jitter(value time.Duration) time.Duration {
	unit := runner.randomUnit()
	factor := (1 - DefaultJitterFraction) + (2 * DefaultJitterFraction * unit)
	return time.Duration(float64(value) * factor)
}

// randomDelay spreads process starts across one complete uplink interval.
func (runner *Runner) randomDelay(maximum time.Duration) time.Duration {
	return time.Duration(float64(maximum) * runner.randomUnit())
}

func (runner *Runner) randomUnit() float64 {
	var document [8]byte
	if _, err := io.ReadFull(runner.random, document[:]); err != nil {
		// Scheduling jitter is not a security primitive. Keep the service alive
		// at the center of the requested range if entropy becomes unavailable.
		return 0.5
	}
	return float64(binary.BigEndian.Uint64(document[:])>>11) / (1 << 53)
}

func drainSnapshots(snapshots <-chan model.Snapshot, latest *model.Snapshot, haveLatest *bool, revision *uint64) bool {
	for {
		select {
		case snapshot, ok := <-snapshots:
			if !ok {
				return true
			}
			*latest, *haveLatest = snapshot, true
			*revision++
		default:
			return false
		}
	}
}

type runnerTimer interface {
	Channel() <-chan time.Time
	Reset(time.Duration) bool
	Stop() bool
}

type standardTimer struct{ *time.Timer }

func (timer *standardTimer) Channel() <-chan time.Time { return timer.C }
