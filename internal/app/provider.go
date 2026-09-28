package app

import (
	"time"

	"github.com/intellisys-stevens/leviathan/adapters/kubernetes/attribution"
	"github.com/intellisys-stevens/leviathan/internal/config"
	workspaceprocess "github.com/intellisys-stevens/leviathan/internal/process"
	"github.com/intellisys-stevens/leviathan/internal/provider"
	"github.com/intellisys-stevens/leviathan/internal/provider/dcgm"
	"github.com/intellisys-stevens/leviathan/internal/provider/fake"
	"github.com/intellisys-stevens/leviathan/internal/provider/nvml"
	"github.com/intellisys-stevens/leviathan/internal/provider/workspace"
)

func HardwareProvider(cfg config.Config) (provider.Provider, error) {
	profileInterval := effectiveInterval(cfg.ProfileInterval, cfg.Interval)
	var source provider.Provider
	if cfg.Provider == "fake" || cfg.Fixture != "" {
		fixture, err := fake.NewFixture(cfg.Fixture, fake.Options{ShowCommandLine: cfg.ShowCommandLine})
		if err != nil {
			return nil, err
		}
		source = fixture
	} else {
		source = nvml.New(nvml.Options{
			NoProfile:         cfg.NoProfile,
			ProfileInterval:   profileInterval,
			ProfileStaleAfter: 2*profileInterval + cfg.Interval,
			TopologyInterval:  cfg.TopologyInterval,
		})
		if cfg.Provider != "nvml" && !cfg.NoProfile {
			source = dcgm.New(source, dcgm.Options{
				Address: cfg.DCGMAddress, Required: cfg.Provider == "dcgm",
				Interval: profileInterval, StaleAfter: 2*profileInterval + cfg.Interval, RescanInterval: cfg.TopologyInterval,
			})
		}
	}
	return source, nil
}

// Provider retains the legacy composite constructor for existing embedders.
func Provider(cfg config.Config) (provider.Provider, error) {
	source, err := HardwareProvider(cfg)
	if err != nil {
		return nil, err
	}
	if cfg.Provider != "fake" && cfg.Fixture == "" {
		source = workspace.New(source, workspaceprocess.NewScannerWithAttribution(cfg.ShowCommandLine, cfg.AttributionSocket != ""), workspace.Options{InventoryInterval: effectiveInterval(cfg.ProcessInterval, cfg.Interval)})
	}
	if cfg.AttributionSocket == "" {
		return source, nil
	}
	client, err := attribution.NewClient(attribution.DefaultClientOptions(cfg.AttributionSocket))
	if err != nil {
		return nil, err
	}
	wrapped := attribution.NewProvider(source, client)
	if cfg.Provider != "fake" && cfg.Fixture == "" {
		wrapped.WithCheckpoint(cfg.AttributionCheckpointPath)
	}
	return wrapped, nil
}

func effectiveInterval(configured, sampling time.Duration) time.Duration {
	if sampling > configured {
		return sampling
	}
	return configured
}
