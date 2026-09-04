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
	if cfg.HistoryWindow != 12*time.Hour || cfg.Interval != time.Second || cfg.ProfileInterval != 2*time.Second || cfg.ProcessInterval != 2*time.Second || cfg.Uplink.Enabled || cfg.Uplink.Interval != 15*time.Second {
		t.Fatalf("unexpected defaults: interval=%s history=%s", cfg.Interval, cfg.HistoryWindow)
	}
}

func TestLoadFileParsesUplinkAndRejectsUnknownFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	document := `[uplink]
enabled = true
base_url = "https://yggdrasil.example.test"
token_file = "/run/credentials/leviathan@root.service/leviathan-uplink-token"
interval = "27s"
`
	if err := os.WriteFile(path, []byte(document), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := Defaults()
	if err := LoadFile(path, &cfg); err != nil {
		t.Fatal(err)
	}
	if !cfg.Uplink.Enabled || cfg.Uplink.BaseURL != "https://yggdrasil.example.test" ||
		cfg.Uplink.TokenFile != "/run/credentials/leviathan@root.service/leviathan-uplink-token" || cfg.Uplink.Interval != 27*time.Second {
		t.Fatalf("uplink config = %+v", cfg.Uplink)
	}
	if err := Validate(cfg); err != nil {
		t.Fatalf("valid uplink rejected: %v", err)
	}

	unknown := filepath.Join(t.TempDir(), "unknown.toml")
	if err := os.WriteFile(unknown, []byte("[uplink]\ntoken = \"DO-NOT-ECHO-THIS-SECRET\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg = Defaults()
	err := LoadFile(unknown, &cfg)
	if err == nil || !strings.Contains(err.Error(), "fields in the document are missing in the target struct") || strings.Contains(err.Error(), "DO-NOT-ECHO-THIS-SECRET") {
		t.Fatalf("unknown uplink field error = %v", err)
	}
}

func TestLoadFilePreservesDefaultUplinkIntervalWhenOmitted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("[uplink]\nenabled = false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := Defaults()
	if err := LoadFile(path, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Uplink.Interval != DefaultUplinkInterval {
		t.Fatalf("uplink interval = %s, want %s", cfg.Uplink.Interval, DefaultUplinkInterval)
	}
}

func TestValidateUplinkRequiresSafeCompleteConfiguration(t *testing.T) {
	valid := Defaults()
	valid.Uplink = UplinkConfig{
		Enabled: true, BaseURL: "https://yggdrasil.example.test", TokenFile: "/run/credentials/leviathan/uplink-token", Interval: 15 * time.Second,
	}
	if err := Validate(valid); err != nil {
		t.Fatalf("valid uplink config rejected: %v", err)
	}
	tests := []struct {
		name      string
		configure func(*Config)
		contains  string
	}{
		{name: "missing base URL", configure: func(cfg *Config) { cfg.Uplink.BaseURL = "" }, contains: "base URL is required"},
		{name: "missing token file", configure: func(cfg *Config) { cfg.Uplink.TokenFile = "" }, contains: "token file is required"},
		{name: "HTTP", configure: func(cfg *Config) { cfg.Uplink.BaseURL = "http://yggdrasil.example.test" }, contains: "HTTPS origin"},
		{name: "URL path", configure: func(cfg *Config) { cfg.Uplink.BaseURL = "https://yggdrasil.example.test/uplink" }, contains: "HTTPS origin"},
		{name: "URL credential", configure: func(cfg *Config) { cfg.Uplink.BaseURL = "https://secret@yggdrasil.example.test" }, contains: "HTTPS origin"},
		{name: "relative token file", configure: func(cfg *Config) { cfg.Uplink.TokenFile = "uplink-token" }, contains: "absolute clean path"},
		{name: "unclean token file", configure: func(cfg *Config) { cfg.Uplink.TokenFile = "/run/../tmp/token" }, contains: "absolute clean path"},
		{name: "short interval", configure: func(cfg *Config) { cfg.Uplink.Interval = 999 * time.Millisecond }, contains: "uplink interval"},
		{name: "long interval", configure: func(cfg *Config) { cfg.Uplink.Interval = time.Hour + time.Second }, contains: "uplink interval"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := valid
			test.configure(&cfg)
			err := Validate(cfg)
			if err == nil || !strings.Contains(err.Error(), test.contains) || strings.Contains(err.Error(), "secret@yggdrasil") {
				t.Fatalf("validation error = %v", err)
			}
		})
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
