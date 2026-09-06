package updater

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

func TestGeneratedRecoveryRemainsActiveAndPrecedesBothServices(t *testing.T) {
	f := newFixture(t)
	host := &setupHost{root: "/"}
	units := managedSetupUnits(host, f.e.config)
	body := string(units["/etc/systemd/system/leviathan-updater-recover.service"].Data)
	for _, required := range []string{
		"Type=oneshot\n", "RemainAfterExit=true\n", "TimeoutStartSec=120s\n",
		"After=local-fs.target\n", "Before=" + f.e.config.Service + " leviathan-updater.service\n",
		"PrivateNetwork=true\n", "NoNewPrivileges=true\n",
	} {
		if !strings.Contains(body, required) {
			t.Errorf("recovery unit missing %q", required)
		}
	}
}

func TestOfflineRecoveryRejectsLiveTransactionLock(t *testing.T) {
	f := newFixture(t)
	unlock, err := lockState(filepath.Join(f.e.config.StateDirectory, "lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if err := f.e.RecoverOffline(context.Background()); err == nil {
		t.Fatal("offline recovery must not bypass a live updater transaction lock")
	}
}

type scriptedProbeService struct {
	Service
	transform func(Probe) Probe
}

func (s *scriptedProbeService) Probe(ctx context.Context) (Probe, error) {
	probe, err := s.Service.Probe(ctx)
	if err != nil {
		return probe, err
	}
	return s.transform(probe), nil
}

// Run the same timing fixtures through both users of the shared checker. The
// fake observer clock advances in one-second probes, never in wall-clock sleeps.
func TestSustainedSamplingAcrossSetupAndUpdates(t *testing.T) {
	for _, mode := range []string{"setup", "update"} {
		for _, scenario := range []struct {
			name        string
			cadence     time.Duration
			freezeAfter time.Duration
			wantAfter   time.Duration
			wantError   bool
		}{
			{"quarter-second", 250 * time.Millisecond, -1, time.Minute, false},
			{"one-second", time.Second, -1, time.Minute, false},
			{"two-second", 2 * time.Second, -1, time.Minute, false},
			{"ten-second", 10 * time.Second, -1, time.Minute, false},
			{"sixty-second", time.Minute, -1, 2 * time.Minute, false},
			{"fully-frozen", time.Second, 0, 0, true},
			{"early-progress-then-frozen", time.Second, time.Second, 0, true},
			{"missing-cadence", 0, -1, 0, true},
			{"unsupported-cadence", 61 * time.Second, -1, 0, true},
		} {
			t.Run(mode+"/"+scenario.name, func(t *testing.T) {
				f := newFixture(t)
				start := f.e.now()
				service := &scriptedProbeService{Service: f.s, transform: func(probe Probe) Probe {
					elapsed := f.e.now().Sub(start)
					if scenario.freezeAfter >= 0 {
						elapsed = min(elapsed, scenario.freezeAfter)
					}
					if scenario.cadence > 0 {
						elapsed = elapsed.Truncate(scenario.cadence)
					}
					probe.SampledAt, probe.SamplingInterval = start.Add(elapsed), scenario.cadence
					return probe
				}}
				f.e.service, f.e.window, f.e.timeout = service, time.Minute, 150*time.Second
				var err error
				if mode == "update" {
					err = f.e.verify(context.Background(), f.installed, Probe{}, "")
				} else {
					host := &setupHost{service: func(Config) Service { return service }, now: f.e.now, sleep: f.e.sleep, verifyWindow: time.Minute, timeLimit: 150 * time.Second}
					err = host.verify(context.Background(), f.e.config, f.installed, Probe{})
				}
				if (err != nil) != scenario.wantError {
					t.Fatalf("verification error=%v, wantError=%v", err, scenario.wantError)
				}
				if !scenario.wantError && f.e.now().Sub(start) != scenario.wantAfter {
					t.Fatalf("accepted after %s, want %s", f.e.now().Sub(start), scenario.wantAfter)
				}
			})
		}
	}
}

func TestSamplingWindowResetsOnDiscontinuity(t *testing.T) {
	for _, scenario := range []string{"regression", "future", "missing-domain", "cadence-change", "probe-failure", "late-jump"} {
		t.Run(scenario, func(t *testing.T) {
			start := time.Unix(1_700_000_000, 0)
			var health samplingHealth
			firstAccepted := -1
			for second := 0; second <= 125; second++ {
				now := start.Add(time.Duration(second) * time.Second)
				probe := Probe{SampledAt: now, SamplingInterval: time.Second}
				valid := true
				if scenario == "late-jump" && second >= 2 && second < 60 {
					probe.SampledAt = start.Add(time.Second)
				}
				if scenario == "cadence-change" && second >= 59 {
					probe.SamplingInterval = 2 * time.Second
				}
				if second == 59 {
					switch scenario {
					case "regression":
						probe.SampledAt = now.Add(-2 * time.Second)
					case "future":
						probe.SampledAt = now.Add(6 * time.Second)
					case "missing-domain", "probe-failure":
						valid = false
					}
				}
				if health.observe(now, probe, valid, time.Minute) && firstAccepted == -1 {
					firstAccepted = second
				}
			}
			if firstAccepted < 119 || firstAccepted > 120 {
				t.Fatalf("healthy window inherited a discontinuity or failed to recover: first accepted at %d", firstAccepted)
			}
		})
	}
}

func TestSlowSamplingStillRequiresTwoAdvances(t *testing.T) {
	var health samplingHealth
	start := time.Unix(1_700_000_000, 0)
	for second := 0; second < 150; second++ {
		now := start.Add(time.Duration(second) * time.Second)
		probe := Probe{SampledAt: start, SamplingInterval: time.Minute}
		if second >= 60 {
			probe.SampledAt = start.Add(time.Minute)
		}
		if health.observe(now, probe, true, time.Minute) {
			t.Fatal("one early advance at a slow cadence was accepted")
		}
	}
}

func TestPartialFreezeTriggersVerifiedRollback(t *testing.T) {
	f := newFixture(t)
	var candidateStart time.Time
	f.e.window, f.e.timeout = time.Minute, 70*time.Second
	f.e.service = &scriptedProbeService{Service: f.s, transform: func(probe Probe) Probe {
		if probe.RunningSHA256 == sum(f.next) {
			if candidateStart.IsZero() {
				candidateStart = f.e.now()
			}
			probe.SampledAt = candidateStart.Add(min(time.Second, f.e.now().Sub(candidateStart)))
		}
		return probe
	}}
	if err := f.e.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.c.results) != 1 || f.c.results[0].Status != p.RolledBack || !f.c.results[0].InstallationVerified {
		t.Fatalf("frozen candidate must produce a verified rollback: %+v", f.c.results)
	}
	if f.s.running != sum(f.old) {
		t.Fatal("previous executable was not restored")
	}
}

func TestProbeCadenceDoesNotChangePersistentJournalFormat(t *testing.T) {
	body, err := json.Marshal(Probe{SamplingInterval: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "SamplingInterval") {
		t.Fatal("observer-only cadence leaked into persisted protocol")
	}
}

func TestVerificationDoesNotAcceptAProbeReturningAfterDeadline(t *testing.T) {
	for _, mode := range []string{"setup", "update"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t)
			calls := 0
			service := &scriptedProbeService{Service: f.s, transform: func(probe Probe) Probe {
				calls++
				if calls == 3 {
					*f.now = f.now.Add(4 * time.Second)
					probe.SampledAt = *f.now
				}
				return probe
			}}
			f.e.service = service
			var err error
			if mode == "update" {
				err = f.e.verify(context.Background(), f.installed, Probe{}, "")
			} else {
				host := &setupHost{service: func(Config) Service { return service }, now: f.e.now, sleep: f.e.sleep, verifyWindow: 2 * time.Second, timeLimit: 5 * time.Second}
				err = host.verify(context.Background(), f.e.config, f.installed, Probe{})
			}
			if err == nil {
				t.Fatal("accepted a healthy response after the overall deadline")
			}
		})
	}
}
