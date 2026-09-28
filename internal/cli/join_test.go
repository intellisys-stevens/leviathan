package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/intellisys-stevens/leviathan/internal/config"
	"github.com/pelletier/go-toml/v2"
)

func TestJoinPreservesOtherSettingsAndLoopback(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	before := []byte("provider = 'fake'\nlisten = '127.0.0.1:31397'\ninterval = '2s'\nno_profile = true\n[uplink]\nenabled = false\ninterval = '3s'\n[health]\nenabled = true\ndirectory = '/var/lib/health'\n")
	if err := os.WriteFile(path, before, 0644); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(t.TempDir(), "state.json")
	if err := writeJoinConfig(path, "https://control.example.test", state); err != nil {
		t.Fatal(err)
	}
	var values map[string]any
	body, _ := os.ReadFile(path)
	if err := toml.Unmarshal(body, &values); err != nil {
		t.Fatal(err)
	}
	if values["provider"] != "fake" || values["listen"] != "127.0.0.1:31397" || values["interval"] != "2s" || values["no_profile"] != true {
		t.Fatal("changed unrelated settings")
	}
	cfg := config.Defaults()
	if err := config.LoadFile(path, &cfg); err != nil {
		t.Fatal(err)
	}
	if err := config.Validate(cfg); err != nil {
		t.Fatal(err)
	}
	if !cfg.Uplink.Enabled || cfg.Uplink.StateFile != state || cfg.Uplink.Schema != "uplink-v2" || cfg.Uplink.Interval.String() != "3s" || !cfg.Health.Enabled {
		t.Fatalf("configuration mismatch: %+v", cfg.Uplink)
	}
}

func TestJoinedServiceAdoptsStockCommandAndPreservesConfiguredArguments(t *testing.T) {
	const configPath = "/etc/leviathan/config.toml"
	const state = "/var/lib/leviathan/enrollment"
	stock := "ExecStart={ path=/usr/local/bin/leviathan ; argv[]=/usr/local/bin/leviathan --listen 127.0.0.1:1397 serve ; ignore_errors=no ; }"
	body, err := joinedServiceDropIn(stock, configPath, state, []string{"203.0.113.10", "2001:db8::10"})
	if err != nil || !strings.Contains(body, `ExecStart=/usr/local/bin/leviathan --config "/etc/leviathan/config.toml" --listen 127.0.0.1:1397 serve`) {
		t.Fatalf("stock monitor must load joined configuration and retain loopback: %v", err)
	}
	if strings.Contains(body, "IPAddressDeny=") || strings.Contains(body, "IPAddressAllow=\n") || !strings.Contains(body, "IPAddressAllow=203.0.113.10 2001:db8::10\n") {
		t.Fatal("enrollment must add bounded network exceptions without clearing operator restrictions")
	}
	adopted := strings.Replace(stock, "--listen", "--config "+configPath+" --listen", 1)
	rerun, err := joinedServiceDropIn(adopted, configPath, state, []string{"203.0.113.10", "2001:db8::10"})
	if err != nil || rerun != body {
		t.Fatalf("rerunning join must retain its own configuration override: %v", err)
	}
	configured := "ExecStart={ path=/opt/custom/leviathan ; argv[]=/opt/custom/leviathan --config /etc/leviathan/config.toml --provider nvml --listen 127.0.0.1:1397 serve ; }"
	body, err = joinedServiceDropIn(configured, configPath, state, []string{"203.0.113.10"})
	if err != nil || strings.Contains(body, "ExecStart=") {
		t.Fatalf("configured monitor arguments must be preserved: %v", err)
	}
	if _, err = joinedServiceDropIn(configured, "/etc/other/config.toml", state, []string{"203.0.113.10"}); err == nil {
		t.Fatal("must not restart an unrelated installation")
	}
}
