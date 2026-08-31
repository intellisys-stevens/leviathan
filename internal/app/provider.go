package app

import (
	"time"

	"github.com/intellisys-stevens/miglens/internal/attribution"
	"github.com/intellisys-stevens/miglens/internal/config"
	workspaceprocess "github.com/intellisys-stevens/miglens/internal/process"
	"github.com/intellisys-stevens/miglens/internal/provider"
	"github.com/intellisys-stevens/miglens/internal/provider/dcgm"
	"github.com/intellisys-stevens/miglens/internal/provider/fake"
	"github.com/intellisys-stevens/miglens/internal/provider/nvml"
	"github.com/intellisys-stevens/miglens/internal/provider/workspace"
)

func Provider(cfg config.Config) (provider.Provider, error) {
	profileInterval := effectiveInterval(cfg.ProfileInterval, cfg.Interval)
	processInterval := effectiveInterval(cfg.ProcessInterval, cfg.Interval)
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
		source = workspace.New(source, workspaceprocess.NewScannerWithAttribution(cfg.ShowCommandLine, cfg.AttributionSocket != ""), workspace.Options{InventoryInterval: processInterval})
	}
	if cfg.AttributionSocket == "" {
		return source, nil
	}
	client, err := attribution.NewClient(attribution.DefaultClientOptions(cfg.AttributionSocket))
	if err != nil {
		return nil, err
	}
	return attribution.NewProvider(source, client), nil
}

func effectiveInterval(configured, sampling time.Duration) time.Duration {
	if sampling > configured {
		return sampling
	}
	return configured
}
