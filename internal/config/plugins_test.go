package config

import (
	"strings"
	"testing"
)

func TestPluginDependenciesAndCapabilityValidation(t *testing.T) {
	for _, test := range []struct {
		name    string
		plugins []PluginConfig
		message string
	}{
		{"cycle", []PluginConfig{{ID: "a", Builtin: "host", Dependencies: []string{"b"}}, {ID: "b", Builtin: "host", Dependencies: []string{"a"}}}, "cycle"},
		{"missing", []PluginConfig{{ID: "a", Builtin: "host", Dependencies: []string{"b"}}}, "unavailable"},
		{"duplicate", []PluginConfig{{ID: "a", Builtin: "host"}, {ID: "a", Builtin: "host"}}, "duplicate"},
		{"socket", []PluginConfig{{ID: "a", Socket: "relative.sock"}}, "absolute"},
		{"capability", []PluginConfig{{ID: "a", Builtin: "host", Capabilities: []string{"unknown"}}}, "capability"},
		{"interval", []PluginConfig{{ID: "a", Builtin: "host", Interval: "0s"}}, "interval"},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg := Defaults()
			cfg.Plugins = test.plugins
			if err := Validate(cfg); err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("validation = %v", err)
			}
		})
	}
}

func TestPluginDefaultsPreserveWorkloadOptIn(t *testing.T) {
	cfg := Defaults()
	cfg.AttributionSocket = "/run/leviathan/bridge.sock"
	for _, plugin := range PluginComposition(cfg) {
		if plugin.Builtin == "workload-cgroups" {
			t.Fatal("workload collection enabled without opt-in")
		}
	}
	cfg.WorkloadTelemetry = true
	found := false
	for _, plugin := range PluginComposition(cfg) {
		found = found || plugin.Builtin == "workload-cgroups"
	}
	if !found {
		t.Fatal("enabled workload collection missing")
	}
	cfg.Plugins = []PluginConfig{{ID: "custom", Socket: "/run/custom.sock"}}
	if got := PluginComposition(cfg); len(got) != 1 || got[0].ID != "custom" {
		t.Fatalf("explicit composition = %+v", got)
	}
}
