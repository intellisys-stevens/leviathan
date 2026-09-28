package config

import (
	"fmt"
	"path/filepath"
	"regexp"
	"time"
)

// PluginConfig selects one installed implementation. Configuration is applied
// on restart; checking it never opens sockets or starts plugin processes.
type PluginConfig struct {
	ID           string   `toml:"id" json:"id"`
	Builtin      string   `toml:"builtin" json:"builtin,omitempty"`
	Socket       string   `toml:"socket" json:"socket,omitempty"`
	Capabilities []string `toml:"capabilities" json:"capabilities,omitempty"`
	Dependencies []string `toml:"dependencies" json:"dependencies,omitempty"`
	Interval     string   `toml:"interval" json:"interval,omitempty"`
	Disabled     bool     `toml:"disabled" json:"disabled,omitempty"`
}

var pluginID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)

func (p PluginConfig) SamplingInterval(fallback time.Duration) time.Duration {
	if p.Interval == "" {
		return fallback
	}
	interval, _ := time.ParseDuration(p.Interval) // validated before construction
	return interval
}

// PluginComposition translates pre-plugin configuration without requiring an
// operator migration. An explicit plugins array replaces this composition.
func PluginComposition(cfg Config) []PluginConfig {
	if cfg.Plugins != nil {
		return cfg.Plugins
	}
	var plugins []PluginConfig
	if cfg.Provider == "fake" || cfg.Fixture != "" {
		plugins = []PluginConfig{{ID: "hardware", Builtin: "fake"}}
	} else {
		plugins = []PluginConfig{
			{ID: "host", Builtin: "host"},
			{ID: "hardware", Builtin: "nvidia"},
			{ID: "processes", Builtin: "processes", Interval: cfg.ProcessInterval.String()},
		}
	}
	if cfg.AttributionSocket != "" {
		plugins = append(plugins, PluginConfig{ID: "environment", Builtin: "coder-kubernetes", Interval: "5s"})
		if cfg.WorkloadTelemetry {
			plugins = append(plugins, PluginConfig{ID: "workloads", Builtin: "workload-cgroups", Interval: "2s"})
		}
		if cfg.GPUCapacity.Enabled {
			plugins = append(plugins, PluginConfig{ID: "capacity", Builtin: "gpu-capacity", Interval: "5s"})
		}
	}
	return plugins
}

func validatePlugins(cfg Config) error {
	plugins := PluginComposition(cfg)
	if len(plugins) > 32 {
		return fmt.Errorf("at most 32 plugin instances are supported")
	}
	byID := make(map[string]PluginConfig, len(plugins))
	for _, plugin := range plugins {
		if !pluginID.MatchString(plugin.ID) {
			return fmt.Errorf("invalid plugin ID %q", plugin.ID)
		}
		if _, exists := byID[plugin.ID]; exists {
			return fmt.Errorf("duplicate plugin ID %q", plugin.ID)
		}
		byID[plugin.ID] = plugin
		if (plugin.Builtin == "") == (plugin.Socket == "") {
			return fmt.Errorf("plugin %s requires exactly one of builtin or socket", plugin.ID)
		}
		if plugin.Socket != "" && (!filepath.IsAbs(plugin.Socket) || filepath.Clean(plugin.Socket) != plugin.Socket) {
			return fmt.Errorf("plugin %s socket must be an absolute clean path", plugin.ID)
		}
		if !plugin.Disabled && (plugin.Builtin == "coder-kubernetes" || plugin.Builtin == "workload-cgroups" || plugin.Builtin == "gpu-capacity") && cfg.AttributionSocket == "" {
			return fmt.Errorf("plugin %s requires attribution_socket", plugin.ID)
		}
		if plugin.Builtin != "" {
			switch plugin.Builtin {
			case "host", "nvidia", "processes", "fake", "coder-kubernetes", "workload-cgroups", "gpu-capacity":
			default:
				return fmt.Errorf("unknown builtin plugin %q", plugin.Builtin)
			}
		}
		if plugin.Interval != "" {
			interval, err := time.ParseDuration(plugin.Interval)
			if err != nil || interval < 250*time.Millisecond || interval > time.Minute {
				return fmt.Errorf("plugin %s interval must be between 250ms and 60s", plugin.ID)
			}
		}
		seen := make(map[string]bool)
		for _, capability := range plugin.Capabilities {
			if allowed, exists := builtinCapabilities[plugin.Builtin]; exists && !allowed[capability] {
				return fmt.Errorf("builtin %s does not provide capability %s", plugin.Builtin, capability)
			}
			switch capability {
			case "host", "gpu", "processes", "workload-inventory", "allocations", "workload-measurements", "gpu-capacity":
			default:
				return fmt.Errorf("plugin %s has unknown capability %q", plugin.ID, capability)
			}
			if seen[capability] {
				return fmt.Errorf("plugin %s repeats capability %q", plugin.ID, capability)
			}
			seen[capability] = true
		}
	}
	visiting, visited := map[string]bool{}, map[string]bool{}
	var visit func(string) error
	visit = func(id string) error {
		if visiting[id] {
			return fmt.Errorf("plugin dependency cycle at %s", id)
		}
		if visited[id] {
			return nil
		}
		visiting[id] = true
		for _, dependency := range byID[id].Dependencies {
			entry, exists := byID[dependency]
			if !exists || entry.Disabled {
				return fmt.Errorf("plugin %s depends on unavailable plugin %s", id, dependency)
			}
			if err := visit(dependency); err != nil {
				return err
			}
		}
		visiting[id], visited[id] = false, true
		return nil
	}
	for _, plugin := range plugins {
		if err := visit(plugin.ID); err != nil {
			return err
		}
	}
	return nil
}

var builtinCapabilities = map[string]map[string]bool{
	"host": {"host": true}, "nvidia": {"gpu": true}, "processes": {"processes": true},
	"fake":             {"host": true, "gpu": true, "processes": true, "workload-inventory": true, "allocations": true, "workload-measurements": true},
	"coder-kubernetes": {"workload-inventory": true, "allocations": true}, "workload-cgroups": {"workload-measurements": true}, "gpu-capacity": {"gpu-capacity": true},
}
