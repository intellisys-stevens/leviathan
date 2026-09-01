package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoopbackEnforcement(t *testing.T) {
	for _, address := range []string{"127.0.0.1:1397", "[::1]:1397", "localhost:1397"} {
		if err := ValidateLoopback(address); err != nil {
			t.Errorf("%s should be accepted: %v", address, err)
		}
	}
	for _, address := range []string{"0.0.0.0:1397", "192.0.2.2:1397", ":1397"} {
		if err := ValidateLoopback(address); err == nil {
			t.Errorf("%s should be refused", address)
		}
	}
}

func TestLoadFileParsesHumanDurationsAndPreservesDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("interval = \"750ms\"\nprofile_interval = \"3s\"\nprocess_interval = \"4s\"\nhistory_window = \"45m\"\nprovider = \"nvml\"\nattribution_socket = \"/run/leviathan/attribution.sock\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := Defaults()
	if err := LoadFile(path, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Interval != 750*time.Millisecond || cfg.ProfileInterval != 3*time.Second || cfg.ProcessInterval != 4*time.Second || cfg.HistoryWindow != 45*time.Minute || cfg.AttributionSocket != "/run/leviathan/attribution.sock" || cfg.Listen != DefaultListen {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestDefaultsRetainOneHourOfHistory(t *testing.T) {
	cfg := Defaults()
	if cfg.HistoryWindow != 12*time.Hour || cfg.Interval != time.Second || cfg.ProfileInterval != 2*time.Second || cfg.ProcessInterval != 2*time.Second {
		t.Fatalf("unexpected defaults: interval=%s history=%s", cfg.Interval, cfg.HistoryWindow)
	}
}

func TestApplyEnvSetsAncillaryIntervalsAndAttribution(t *testing.T) {
	t.Setenv("LEVIATHAN_PROFILE_INTERVAL", "2500ms")
	t.Setenv("LEVIATHAN_PROCESS_INTERVAL", "3s")
	t.Setenv("LEVIATHAN_ATTRIBUTION_SOCKET", "/run/leviathan/attribution.sock")
	cfg := Defaults()
	if err := ApplyEnv(&cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.ProfileInterval != 2500*time.Millisecond || cfg.ProcessInterval != 3*time.Second || cfg.AttributionSocket == "" {
		t.Fatalf("environment config = %+v", cfg)
	}
}

func TestApplyEnvRejectsLegacyMIGLensVariables(t *testing.T) {
	t.Setenv("MIGLENS_INTERVAL", "500ms")
	cfg := Defaults()
	err := ApplyEnv(&cfg)
	if err == nil || !strings.Contains(err.Error(), "MIGLENS_INTERVAL") || !strings.Contains(err.Error(), "LEVIATHAN_INTERVAL") {
		t.Fatalf("legacy environment error = %v", err)
	}
}

func TestValidateAncillaryIntervalsAndSocket(t *testing.T) {
	tests := []Config{Defaults(), Defaults(), Defaults()}
	tests[0].ProfileInterval = 100 * time.Millisecond
	tests[1].ProcessInterval = 61 * time.Second
	tests[2].AttributionSocket = "relative.sock"
	for _, cfg := range tests {
		if err := Validate(cfg); err == nil {
			t.Fatalf("invalid config accepted: %+v", cfg)
		}
	}
	valid := Defaults()
	valid.AttributionSocket = "/run/leviathan/attribution.sock"
	if err := Validate(valid); err != nil {
		t.Fatalf("valid attribution socket rejected: %v", err)
	}
}
