package app

import (
	"github.com/miglens/miglens/internal/config"
	workspaceprocess "github.com/miglens/miglens/internal/process"
	"github.com/miglens/miglens/internal/provider"
	"github.com/miglens/miglens/internal/provider/dcgm"
	"github.com/miglens/miglens/internal/provider/fake"
	"github.com/miglens/miglens/internal/provider/nvml"
	"github.com/miglens/miglens/internal/provider/workspace"
)

func Provider(cfg config.Config) (provider.Provider, error) {
	var source provider.Provider
	if cfg.Provider == "fake" || cfg.Fixture != "" {
		fixture, err := fake.NewFixture(cfg.Fixture, fake.Options{ShowCommandLine: cfg.ShowCommandLine})
		if err != nil {
			return nil, err
		}
		return fixture, nil
	} else {
		source = nvml.New(nvml.Options{NoProfile: cfg.NoProfile})
		if cfg.Provider != "nvml" && !cfg.NoProfile {
			source = dcgm.New(source, dcgm.Options{Address: cfg.DCGMAddress, Required: cfg.Provider == "dcgm", Interval: cfg.Interval, RescanInterval: cfg.TopologyInterval})
		}
	}
	return workspace.New(source, workspaceprocess.NewScanner(cfg.ShowCommandLine)), nil
}
