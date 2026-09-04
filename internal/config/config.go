package config

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/intellisys-stevens/leviathan/internal/uplink"
	"github.com/pelletier/go-toml/v2"
)

const (
	DefaultListen         = "127.0.0.1:1397"
	DefaultUplinkInterval = uplink.DefaultInterval
)

type UplinkConfig struct {
	Enabled   bool          `toml:"enabled"`
	BaseURL   string        `toml:"base_url"`
	TokenFile string        `toml:"token_file"`
	Interval  time.Duration `toml:"interval"`
}

type Config struct {
	Interval          time.Duration `toml:"interval"`
	ProfileInterval   time.Duration `toml:"profile_interval"`
	ProcessInterval   time.Duration `toml:"process_interval"`
	HistoryWindow     time.Duration `toml:"history_window"`
	TopologyInterval  time.Duration `toml:"topology_interval"`
	Provider          string        `toml:"provider"`
	DCGMAddress       string        `toml:"dcgm_address"`
	ShowCommandLine   bool          `toml:"show_command_line"`
	NoProfile         bool          `toml:"no_profile"`
	Listen            string        `toml:"listen"`
	NoColor           bool          `toml:"no_color"`
	ASCII             bool          `toml:"ascii"`
	Fixture           string        `toml:"fixture"`
	AttributionSocket string        `toml:"attribution_socket"`
	Uplink            UplinkConfig  `toml:"uplink"`
	ConfigFile        string        `toml:"-"`
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
	Interval          fileDuration     `toml:"interval"`
	ProfileInterval   fileDuration     `toml:"profile_interval"`
	ProcessInterval   fileDuration     `toml:"process_interval"`
	HistoryWindow     fileDuration     `toml:"history_window"`
	TopologyInterval  fileDuration     `toml:"topology_interval"`
	Provider          string           `toml:"provider"`
	DCGMAddress       string           `toml:"dcgm_address"`
	ShowCommandLine   bool             `toml:"show_command_line"`
	NoProfile         bool             `toml:"no_profile"`
	Listen            string           `toml:"listen"`
	NoColor           bool             `toml:"no_color"`
	ASCII             bool             `toml:"ascii"`
	Fixture           string           `toml:"fixture"`
	AttributionSocket string           `toml:"attribution_socket"`
	Uplink            fileUplinkConfig `toml:"uplink"`
}

type fileUplinkConfig struct {
	Enabled   bool         `toml:"enabled"`
	BaseURL   string       `toml:"base_url"`
	TokenFile string       `toml:"token_file"`
	Interval  fileDuration `toml:"interval"`
}

// RejectLegacyEnv prevents a partial migration from silently starting with
// ignored MIGLens configuration.
func RejectLegacyEnv() error {
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(name, "MIGLENS_") {
			continue
		}
		replacement := "LEVIATHAN_" + strings.TrimPrefix(name, "MIGLENS_")
		return fmt.Errorf("legacy environment variable %s is no longer supported; rename it to %s", name, replacement)
	}
	return nil
}

// ApplyEnv overlays supported LEVIATHAN_* environment variables on cfg.
func ApplyEnv(cfg *Config) error {
	if err := RejectLegacyEnv(); err != nil {
		return err
	}
	durations := map[string]*time.Duration{
		"LEVIATHAN_INTERVAL":          &cfg.Interval,
		"LEVIATHAN_PROFILE_INTERVAL":  &cfg.ProfileInterval,
		"LEVIATHAN_PROCESS_INTERVAL":  &cfg.ProcessInterval,
		"LEVIATHAN_HISTORY_WINDOW":    &cfg.HistoryWindow,
		"LEVIATHAN_TOPOLOGY_INTERVAL": &cfg.TopologyInterval,
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
		"LEVIATHAN_PROVIDER":           &cfg.Provider,
		"LEVIATHAN_DCGM_ADDRESS":       &cfg.DCGMAddress,
		"LEVIATHAN_LISTEN":             &cfg.Listen,
		"LEVIATHAN_FIXTURE":            &cfg.Fixture,
		"LEVIATHAN_ATTRIBUTION_SOCKET": &cfg.AttributionSocket,
	}
	for name, target := range stringsMap {
		if value, ok := os.LookupEnv(name); ok {
			*target = value
		}
	}
	bools := map[string]*bool{
		"LEVIATHAN_SHOW_COMMAND_LINE": &cfg.ShowCommandLine,
		"LEVIATHAN_NO_PROFILE":        &cfg.NoProfile,
		"LEVIATHAN_NO_COLOR":          &cfg.NoColor,
		"LEVIATHAN_ASCII":             &cfg.ASCII,
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
		Interval: time.Second, ProfileInterval: 2 * time.Second, ProcessInterval: 2 * time.Second,
		HistoryWindow: 12 * time.Hour, TopologyInterval: 10 * time.Second,
		Provider: "auto", DCGMAddress: "127.0.0.1:5555", Listen: DefaultListen,
		Uplink: UplinkConfig{Interval: DefaultUplinkInterval},
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
	return filepath.Join(base, "leviathan", "config.toml")
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
		Interval: fileDuration(cfg.Interval), ProfileInterval: fileDuration(cfg.ProfileInterval), ProcessInterval: fileDuration(cfg.ProcessInterval),
		HistoryWindow: fileDuration(cfg.HistoryWindow), TopologyInterval: fileDuration(cfg.TopologyInterval),
		Provider: cfg.Provider, DCGMAddress: cfg.DCGMAddress, ShowCommandLine: cfg.ShowCommandLine, NoProfile: cfg.NoProfile,
		Listen: cfg.Listen, NoColor: cfg.NoColor, ASCII: cfg.ASCII, Fixture: cfg.Fixture, AttributionSocket: cfg.AttributionSocket,
		Uplink: fileUplinkConfig{Enabled: cfg.Uplink.Enabled, BaseURL: cfg.Uplink.BaseURL, TokenFile: cfg.Uplink.TokenFile, Interval: fileDuration(cfg.Uplink.Interval)},
	}
	decoder := toml.NewDecoder(bytes.NewReader(data)).DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	cfg.Interval, cfg.ProfileInterval, cfg.ProcessInterval = time.Duration(decoded.Interval), time.Duration(decoded.ProfileInterval), time.Duration(decoded.ProcessInterval)
	cfg.HistoryWindow, cfg.TopologyInterval = time.Duration(decoded.HistoryWindow), time.Duration(decoded.TopologyInterval)
	cfg.Provider, cfg.DCGMAddress = decoded.Provider, decoded.DCGMAddress
	cfg.ShowCommandLine, cfg.NoProfile, cfg.Listen = decoded.ShowCommandLine, decoded.NoProfile, decoded.Listen
	cfg.NoColor, cfg.ASCII, cfg.Fixture, cfg.AttributionSocket = decoded.NoColor, decoded.ASCII, decoded.Fixture, decoded.AttributionSocket
	cfg.Uplink = UplinkConfig{
		Enabled: decoded.Uplink.Enabled, BaseURL: decoded.Uplink.BaseURL, TokenFile: decoded.Uplink.TokenFile,
		Interval: time.Duration(decoded.Uplink.Interval),
	}
	cfg.ConfigFile = path
	return nil
}

func Validate(cfg Config) error {
	if cfg.Interval < 250*time.Millisecond || cfg.Interval > 60*time.Second {
		return fmt.Errorf("interval must be between 250ms and 60s")
	}
	if cfg.ProfileInterval < 250*time.Millisecond || cfg.ProfileInterval > 60*time.Second {
		return fmt.Errorf("profile interval must be between 250ms and 60s")
	}
	if cfg.ProcessInterval < 250*time.Millisecond || cfg.ProcessInterval > 60*time.Second {
		return fmt.Errorf("process interval must be between 250ms and 60s")
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
	if cfg.AttributionSocket != "" {
		if !filepath.IsAbs(cfg.AttributionSocket) {
			return fmt.Errorf("attribution socket must be an absolute path")
		}
		if cleaned := filepath.Clean(cfg.AttributionSocket); cleaned != cfg.AttributionSocket {
			return fmt.Errorf("attribution socket must be a clean path; got %q", cfg.AttributionSocket)
		}
	}
	if cfg.Uplink.Interval < uplink.MinimumInterval || cfg.Uplink.Interval > uplink.MaximumInterval {
		return fmt.Errorf("uplink interval must be between %s and %s", uplink.MinimumInterval, uplink.MaximumInterval)
	}
	if cfg.Uplink.BaseURL != "" {
		if err := uplink.ValidateBaseURL(cfg.Uplink.BaseURL); err != nil {
			return fmt.Errorf("uplink base URL must be a credential-free HTTPS origin")
		}
	}
	if cfg.Uplink.TokenFile != "" {
		if len(cfg.Uplink.TokenFile) > 4096 || !filepath.IsAbs(cfg.Uplink.TokenFile) || filepath.Clean(cfg.Uplink.TokenFile) != cfg.Uplink.TokenFile ||
			strings.IndexFunc(cfg.Uplink.TokenFile, unicode.IsControl) >= 0 {
			return fmt.Errorf("uplink token file must be an absolute clean path")
		}
	}
	if cfg.Uplink.Enabled {
		if cfg.Uplink.BaseURL == "" {
			return fmt.Errorf("uplink base URL is required when uplink is enabled")
		}
		if cfg.Uplink.TokenFile == "" {
			return fmt.Errorf("uplink token file is required when uplink is enabled")
		}
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
		return fmt.Errorf("Leviathan only listens on loopback; got %q", host)
	}
	return nil
}
