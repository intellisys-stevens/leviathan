package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

const DefaultListen = "127.0.0.1:1397"

type Config struct {
	Interval         time.Duration `toml:"interval"`
	HistoryWindow    time.Duration `toml:"history_window"`
	TopologyInterval time.Duration `toml:"topology_interval"`
	Provider         string        `toml:"provider"`
	DCGMAddress      string        `toml:"dcgm_address"`
	ShowCommandLine  bool          `toml:"show_command_line"`
	NoProfile        bool          `toml:"no_profile"`
	Listen           string        `toml:"listen"`
	NoColor          bool          `toml:"no_color"`
	ASCII            bool          `toml:"ascii"`
	Fixture          string        `toml:"fixture"`
	ConfigFile       string        `toml:"-"`
}

type fileDuration time.Duration

func (d *fileDuration) UnmarshalText(text []byte) error {
	parsed, err := time.ParseDuration(string(text))
	if err != nil {
		return err
	}
	*d = fileDuration(parsed)
	return nil
}

type fileConfig struct {
	Interval         fileDuration `toml:"interval"`
	HistoryWindow    fileDuration `toml:"history_window"`
	TopologyInterval fileDuration `toml:"topology_interval"`
	Provider         string       `toml:"provider"`
	DCGMAddress      string       `toml:"dcgm_address"`
	ShowCommandLine  bool         `toml:"show_command_line"`
	NoProfile        bool         `toml:"no_profile"`
	Listen           string       `toml:"listen"`
	NoColor          bool         `toml:"no_color"`
	ASCII            bool         `toml:"ascii"`
	Fixture          string       `toml:"fixture"`
}

// ApplyEnv overlays supported MIGLENS_* environment variables on cfg.
func ApplyEnv(cfg *Config) error {
	durations := map[string]*time.Duration{
		"MIGLENS_INTERVAL":          &cfg.Interval,
		"MIGLENS_HISTORY_WINDOW":    &cfg.HistoryWindow,
		"MIGLENS_TOPOLOGY_INTERVAL": &cfg.TopologyInterval,
	}
	for name, target := range durations {
		if raw, ok := os.LookupEnv(name); ok {
			value, err := time.ParseDuration(raw)
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			*target = value
		}
	}
	stringsMap := map[string]*string{
		"MIGLENS_PROVIDER":     &cfg.Provider,
		"MIGLENS_DCGM_ADDRESS": &cfg.DCGMAddress,
		"MIGLENS_LISTEN":       &cfg.Listen,
		"MIGLENS_FIXTURE":      &cfg.Fixture,
	}
	for name, target := range stringsMap {
		if value, ok := os.LookupEnv(name); ok {
			*target = value
		}
	}
	bools := map[string]*bool{
		"MIGLENS_SHOW_COMMAND_LINE": &cfg.ShowCommandLine,
		"MIGLENS_NO_PROFILE":        &cfg.NoProfile,
		"MIGLENS_NO_COLOR":          &cfg.NoColor,
		"MIGLENS_ASCII":             &cfg.ASCII,
	}
	for name, target := range bools {
		if raw, ok := os.LookupEnv(name); ok {
			value, err := strconv.ParseBool(raw)
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			*target = value
		}
	}
	if _, ok := os.LookupEnv("NO_COLOR"); ok {
		cfg.NoColor = true
	}
	return nil
}

func Defaults() Config {
	return Config{
		Interval: time.Second, HistoryWindow: time.Hour, TopologyInterval: 10 * time.Second,
		Provider: "auto", DCGMAddress: "127.0.0.1:5555", Listen: DefaultListen,
	}
}

func DefaultPath() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "miglens", "config.toml")
}

func LoadFile(path string, cfg *Config) error {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	decoded := fileConfig{
		Interval: fileDuration(cfg.Interval), HistoryWindow: fileDuration(cfg.HistoryWindow), TopologyInterval: fileDuration(cfg.TopologyInterval),
		Provider: cfg.Provider, DCGMAddress: cfg.DCGMAddress, ShowCommandLine: cfg.ShowCommandLine, NoProfile: cfg.NoProfile,
		Listen: cfg.Listen, NoColor: cfg.NoColor, ASCII: cfg.ASCII, Fixture: cfg.Fixture,
	}
	if err := toml.Unmarshal(data, &decoded); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	cfg.Interval, cfg.HistoryWindow, cfg.TopologyInterval = time.Duration(decoded.Interval), time.Duration(decoded.HistoryWindow), time.Duration(decoded.TopologyInterval)
	cfg.Provider, cfg.DCGMAddress = decoded.Provider, decoded.DCGMAddress
	cfg.ShowCommandLine, cfg.NoProfile, cfg.Listen = decoded.ShowCommandLine, decoded.NoProfile, decoded.Listen
	cfg.NoColor, cfg.ASCII, cfg.Fixture = decoded.NoColor, decoded.ASCII, decoded.Fixture
	cfg.ConfigFile = path
	return nil
}

func Validate(cfg Config) error {
	if cfg.Interval < 250*time.Millisecond || cfg.Interval > 60*time.Second {
		return fmt.Errorf("interval must be between 250ms and 60s")
	}
	if cfg.HistoryWindow < cfg.Interval {
		return fmt.Errorf("history window must be at least one interval")
	}
	if cfg.TopologyInterval < cfg.Interval {
		return fmt.Errorf("topology interval must be at least one interval")
	}
	switch cfg.Provider {
	case "auto", "nvml", "dcgm", "fake":
	default:
		return fmt.Errorf("provider must be auto, nvml, dcgm, or fake")
	}
	return nil
}

func ValidateLoopback(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid listen address %q: %w", address, err)
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("MIGLens v0.1 only listens on loopback; got %q", host)
	}
	return nil
}
