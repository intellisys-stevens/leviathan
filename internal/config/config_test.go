package config

import (
	"os"
	"path/filepath"
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
	if err := os.WriteFile(path, []byte("interval = \"750ms\"\nhistory_window = \"45m\"\nprovider = \"nvml\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := Defaults()
	if err := LoadFile(path, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Interval != 750*time.Millisecond || cfg.HistoryWindow != 45*time.Minute || cfg.Listen != DefaultListen {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestDefaultsRetainOneHourOfHistory(t *testing.T) {
	cfg := Defaults()
	if cfg.HistoryWindow != time.Hour || cfg.Interval != time.Second {
		t.Fatalf("unexpected defaults: interval=%s history=%s", cfg.Interval, cfg.HistoryWindow)
	}
}
