// Package hubconfig loads the non-secret configuration for the standalone
// MIGLens fleet controller. OpenStack credentials remain in standard OS_*
// environment variables and are never accepted in this file.
package hubconfig

import (
	"bytes"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/intellisys-stevens/miglens/internal/agentclient"
	localconfig "github.com/intellisys-stevens/miglens/internal/config"
	"github.com/intellisys-stevens/miglens/internal/fleet"
	"github.com/intellisys-stevens/miglens/internal/fleetapi"
	"github.com/intellisys-stevens/miglens/internal/fleetuplink"
	"github.com/pelletier/go-toml/v2"
)

const DefaultListen = "127.0.0.1:1398"

type OpenStack struct {
	AllowedProjectIDs       []string `toml:"allowed_project_ids"`
	AllowedAuthHosts        []string `toml:"allowed_auth_hosts"`
	AllowedComputeHosts     []string `toml:"allowed_compute_hosts"`
	MaxInstances            int      `toml:"max_instances"`
	RequestTimeout          string   `toml:"request_timeout"`
	ConsoleMetricsEnabled   bool     `toml:"console_metrics_enabled"`
	ConsoleLines            int      `toml:"console_lines"`
	ConsoleMaxAge           string   `toml:"console_max_age"`
	ConsoleMaxResponseBytes int64    `toml:"console_max_response_bytes"`
}

type Instance struct {
	UUID            string `toml:"uuid"`
	CreatorID       string `toml:"creator_id"`
	CreatorUsername string `toml:"creator_username"`
	AgentURL        string `toml:"agent_url"`
	AgentHostname   string `toml:"agent_hostname"`
}

type Creator struct {
	CreatorID        string `toml:"creator_id"`
	CreatorUsername  string `toml:"creator_username"`
	TelemetryEnabled bool   `toml:"telemetry_enabled"`
	UplinkTokenEnv   string `toml:"uplink_token_env"`
}

type Uplink struct {
	Enabled                 bool   `toml:"enabled"`
	TTL                     string `toml:"ttl"`
	MaxSampleAge            string `toml:"max_sample_age"`
	MaxFutureSkew           string `toml:"max_future_skew"`
	MaxBodyBytes            int64  `toml:"max_body_bytes"`
	MaxEntries              int    `toml:"max_entries"`
	MaxRetainedBytes        int64  `toml:"max_retained_bytes"`
	MaxCreatorRetainedBytes int64  `toml:"max_creator_retained_bytes"`
	MaxConcurrentRequests   int    `toml:"max_concurrent_requests"`
}

type Config struct {
	Listen              string        `toml:"listen"`
	RefreshInterval     time.Duration `toml:"-"`
	AgentTimeout        time.Duration `toml:"-"`
	AgentStaleAfter     time.Duration `toml:"-"`
	MaxConcurrentAgents int           `toml:"max_concurrent_agents"`
	NidhoggDashboardURL string        `toml:"nidhogg_dashboard_url"`
	OpenStack           OpenStack     `toml:"openstack"`
	Uplink              Uplink        `toml:"uplink"`
	Instances           []Instance    `toml:"instances"`
	Creators            []Creator     `toml:"creators"`
}

type fileConfig struct {
	Listen              string     `toml:"listen"`
	RefreshInterval     string     `toml:"refresh_interval"`
	AgentTimeout        string     `toml:"agent_timeout"`
	AgentStaleAfter     string     `toml:"agent_stale_after"`
	MaxConcurrentAgents int        `toml:"max_concurrent_agents"`
	NidhoggDashboardURL string     `toml:"nidhogg_dashboard_url"`
	OpenStack           OpenStack  `toml:"openstack"`
	Uplink              Uplink     `toml:"uplink"`
	Instances           []Instance `toml:"instances"`
	Creators            []Creator  `toml:"creators"`
}

func Load(path string) (Config, error) {
	if strings.TrimSpace(path) == "" {
		return Config{}, errors.New("fleet controller config path is required")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read fleet controller config: %w", err)
	}
	file := fileConfig{
		Listen:              DefaultListen,
		RefreshInterval:     "30s",
		AgentTimeout:        "8s",
		AgentStaleAfter:     "45s",
		MaxConcurrentAgents: 4,
	}
	decoder := toml.NewDecoder(bytes.NewReader(data)).DisallowUnknownFields()
	if err := decoder.Decode(&file); err != nil {
		return Config{}, errors.New("parse fleet controller config")
	}
	config := Config{
		Listen:              file.Listen,
		MaxConcurrentAgents: file.MaxConcurrentAgents,
		NidhoggDashboardURL: file.NidhoggDashboardURL,
		OpenStack:           file.OpenStack,
		Uplink:              file.Uplink,
		Instances:           append([]Instance(nil), file.Instances...),
		Creators:            append([]Creator(nil), file.Creators...),
	}
	if config.RefreshInterval, err = parseDuration("refresh_interval", file.RefreshInterval, 5*time.Second, 5*time.Minute); err != nil {
		return Config{}, err
	}
	if config.AgentTimeout, err = parseDuration("agent_timeout", file.AgentTimeout, time.Second, 30*time.Second); err != nil {
		return Config{}, err
	}
	if config.AgentStaleAfter, err = parseDuration("agent_stale_after", file.AgentStaleAfter, time.Second, 30*time.Minute); err != nil {
		return Config{}, err
	}
	if err := validate(config); err != nil {
		return Config{}, err
	}
	return config, nil
}

func parseDuration(name, raw string, minimum, maximum time.Duration) (time.Duration, error) {
	value, err := time.ParseDuration(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be between %s and %s", name, minimum, maximum)
	}
	return value, nil
}

func validate(config Config) error {
	if err := localconfig.ValidateLoopback(config.Listen); err != nil {
		return err
	}
	if config.MaxConcurrentAgents < 1 || config.MaxConcurrentAgents > 64 {
		return errors.New("max_concurrent_agents must be between 1 and 64")
	}
	if err := validateDashboardURL(config.NidhoggDashboardURL); err != nil {
		return err
	}
	if len(config.OpenStack.AllowedProjectIDs) == 0 || len(config.OpenStack.AllowedAuthHosts) == 0 || len(config.OpenStack.AllowedComputeHosts) == 0 {
		return errors.New("OpenStack project, auth host, and compute host allowlists are required")
	}
	if config.OpenStack.MaxInstances < 0 || config.OpenStack.MaxInstances > 10_000 {
		return errors.New("OpenStack max_instances must be between 1 and 10000 when set")
	}
	if config.OpenStack.RequestTimeout != "" {
		if _, err := parseDuration("openstack.request_timeout", config.OpenStack.RequestTimeout, time.Second, time.Minute); err != nil {
			return err
		}
	}
	if config.OpenStack.ConsoleLines < 0 || config.OpenStack.ConsoleLines > 200 {
		return errors.New("openstack.console_lines must be between 1 and 200 when set")
	}
	if config.OpenStack.ConsoleMaxResponseBytes < 0 || (config.OpenStack.ConsoleMaxResponseBytes > 0 && (config.OpenStack.ConsoleMaxResponseBytes < 4096 || config.OpenStack.ConsoleMaxResponseBytes > 1024*1024)) {
		return errors.New("openstack.console_max_response_bytes must be between 4096 and 1048576 when set")
	}
	if config.OpenStack.ConsoleMaxAge != "" {
		if _, err := parseDuration("openstack.console_max_age", config.OpenStack.ConsoleMaxAge, 5*time.Second, 30*time.Minute); err != nil {
			return err
		}
	}
	if !config.OpenStack.ConsoleMetricsEnabled && (config.OpenStack.ConsoleLines != 0 || config.OpenStack.ConsoleMaxAge != "" || config.OpenStack.ConsoleMaxResponseBytes != 0) {
		return errors.New("OpenStack console tuning requires console_metrics_enabled")
	}
	if err := validateUplink(config); err != nil {
		return err
	}
	for _, creator := range config.Creators {
		if !creator.TelemetryEnabled {
			continue
		}
		if config.OpenStack.ConsoleMetricsEnabled || (config.Uplink.Enabled && creator.UplinkTokenEnv != "") {
			continue
		}
		return errors.New("creator telemetry_enabled requires console metrics or a creator uplink token reference")
	}

	bindings := make(map[string]agentclient.Binding)
	for _, instance := range config.Instances {
		if (instance.AgentURL == "") != (instance.AgentHostname == "") {
			return errors.New("agent_url and agent_hostname must be configured together")
		}
		if instance.AgentURL != "" {
			bindings[instance.UUID] = agentclient.Binding{BaseURL: instance.AgentURL, ExpectedHostname: instance.AgentHostname}
		}
	}
	if _, err := config.Policy(); err != nil {
		return fmt.Errorf("invalid instance allowlist: %w", err)
	}
	if _, err := agentclient.New(bindings, agentclient.Options{}); err != nil {
		return fmt.Errorf("invalid agent bindings: %w", err)
	}
	return nil
}

func validateDashboardURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.Opaque != "" || parsed.RawPath != "" || strings.Contains(raw, `\`) {
		return errors.New("nidhogg_dashboard_url must be a credential-free HTTPS URL")
	}
	return nil
}

var environmentVariableName = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)

func validateUplink(config Config) error {
	configured := config.Uplink.TTL != "" || config.Uplink.MaxSampleAge != "" || config.Uplink.MaxFutureSkew != "" || config.Uplink.MaxBodyBytes != 0 ||
		config.Uplink.MaxEntries != 0 || config.Uplink.MaxRetainedBytes != 0 || config.Uplink.MaxCreatorRetainedBytes != 0 || config.Uplink.MaxConcurrentRequests != 0
	for _, creator := range config.Creators {
		configured = configured || creator.UplinkTokenEnv != ""
	}
	if !config.Uplink.Enabled {
		if configured {
			return errors.New("uplink settings and token references require uplink.enabled")
		}
		return nil
	}
	ttl := fleetuplink.DefaultTTL
	maxSampleAge := fleetuplink.DefaultMaxSampleAge
	for name, targetAndRaw := range map[string]struct {
		target *time.Duration
		raw    string
	}{
		"uplink.ttl":             {target: &ttl, raw: config.Uplink.TTL},
		"uplink.max_sample_age":  {target: &maxSampleAge, raw: config.Uplink.MaxSampleAge},
		"uplink.max_future_skew": {raw: config.Uplink.MaxFutureSkew},
	} {
		raw := targetAndRaw.raw
		if raw == "" {
			continue
		}
		minimum := time.Second
		maximum := 30 * time.Minute
		if name == "uplink.max_future_skew" {
			maximum = 5 * time.Minute
		}
		parsed, err := parseDuration(name, raw, minimum, maximum)
		if err != nil {
			return err
		}
		if targetAndRaw.target != nil {
			*targetAndRaw.target = parsed
		}
	}
	if ttl < maxSampleAge {
		return errors.New("uplink.ttl must be greater than or equal to uplink.max_sample_age")
	}
	if config.Uplink.MaxBodyBytes < 0 || config.Uplink.MaxBodyBytes > 32<<20 || (config.Uplink.MaxBodyBytes > 0 && config.Uplink.MaxBodyBytes < 4<<10) {
		return errors.New("uplink.max_body_bytes must be between 4096 and 33554432 when set")
	}
	if config.Uplink.MaxEntries < 0 || config.Uplink.MaxEntries > 10_000 {
		return errors.New("uplink.max_entries must be between 1 and 10000 when set")
	}
	maxBodyBytes := config.Uplink.MaxBodyBytes
	if maxBodyBytes == 0 {
		maxBodyBytes = fleetuplink.DefaultMaxBodyBytes
	}
	maxRetainedBytes := config.Uplink.MaxRetainedBytes
	if maxRetainedBytes == 0 {
		maxRetainedBytes = fleetuplink.DefaultMaxRetainedBytes
	}
	maxCreatorRetainedBytes := config.Uplink.MaxCreatorRetainedBytes
	if maxCreatorRetainedBytes == 0 {
		maxCreatorRetainedBytes = fleetuplink.DefaultMaxCreatorBytes
	}
	if maxRetainedBytes < 0 || maxRetainedBytes > fleetuplink.MaximumMaxRetainedBytes ||
		maxCreatorRetainedBytes < 0 || maxCreatorRetainedBytes > fleetuplink.MaximumMaxCreatorBytes ||
		maxBodyBytes > maxCreatorRetainedBytes || maxCreatorRetainedBytes > maxRetainedBytes {
		return errors.New("uplink retained-byte limits must satisfy max_body_bytes <= max_creator_retained_bytes <= max_retained_bytes")
	}
	if config.Uplink.MaxConcurrentRequests < 0 || config.Uplink.MaxConcurrentRequests > fleetapi.MaximumUplinkConcurrentRequests {
		return errors.New("uplink.max_concurrent_requests must be between 1 and 64 when set")
	}
	maxConcurrentRequests := config.Uplink.MaxConcurrentRequests
	if maxConcurrentRequests == 0 {
		maxConcurrentRequests = fleetapi.DefaultUplinkConcurrentRequests
	}
	if maxBodyBytes > fleetapi.MaximumUplinkInflightBytes/int64(maxConcurrentRequests) {
		return errors.New("uplink max_body_bytes times max_concurrent_requests must not exceed 268435456 bytes")
	}
	seenEnvironment := make(map[string]struct{})
	configuredCreators := 0
	for _, creator := range config.Creators {
		if creator.UplinkTokenEnv == "" {
			continue
		}
		if !creator.TelemetryEnabled {
			return errors.New("creator uplink_token_env requires telemetry_enabled")
		}
		if !environmentVariableName.MatchString(creator.UplinkTokenEnv) {
			return errors.New("creator uplink_token_env must be an exact environment variable name")
		}
		if _, duplicate := seenEnvironment[creator.UplinkTokenEnv]; duplicate {
			return errors.New("creator uplink_token_env values must be unique")
		}
		seenEnvironment[creator.UplinkTokenEnv] = struct{}{}
		configuredCreators++
	}
	if configuredCreators == 0 {
		return errors.New("uplink.enabled requires at least one creator uplink_token_env")
	}
	return nil
}

func (config Config) Policy() (fleet.Policy, error) {
	uplinkCreators := make(map[string]struct{})
	if config.Uplink.Enabled {
		for _, creator := range config.Creators {
			if creator.TelemetryEnabled && creator.UplinkTokenEnv != "" {
				uplinkCreators[creator.CreatorID] = struct{}{}
			}
		}
	}
	entries := make(map[string]fleet.AllowedIdentity, len(config.Instances))
	for _, instance := range config.Instances {
		if _, duplicate := entries[instance.UUID]; duplicate {
			return fleet.Policy{}, errors.New("instance UUIDs must be unique")
		}
		_, uplinkConfigured := uplinkCreators[instance.CreatorID]
		// An exact rule pins identity; it does not disable other explicitly
		// enabled telemetry routes for that same pinned creator.
		entries[instance.UUID] = fleet.AllowedIdentity{CreatorID: instance.CreatorID, CreatorUsername: instance.CreatorUsername,
			AgentConfigured: instance.AgentURL != "" || config.OpenStack.ConsoleMetricsEnabled || uplinkConfigured}
	}
	creators := make([]fleet.AllowedCreator, 0, len(config.Creators))
	for _, creator := range config.Creators {
		creators = append(creators, fleet.AllowedCreator{
			CreatorID:        creator.CreatorID,
			CreatorUsername:  creator.CreatorUsername,
			TelemetryEnabled: creator.TelemetryEnabled,
		})
	}
	return fleet.NewPolicyWithCreators(entries, creators)
}

func (config Config) AgentBindings() map[string]agentclient.Binding {
	bindings := make(map[string]agentclient.Binding)
	for _, instance := range config.Instances {
		if instance.AgentURL != "" {
			bindings[instance.UUID] = agentclient.Binding{BaseURL: instance.AgentURL, ExpectedHostname: instance.AgentHostname}
		}
	}
	return bindings
}

func (config Config) OpenStackRequestTimeout() (time.Duration, error) {
	if config.OpenStack.RequestTimeout == "" {
		return 0, nil
	}
	return time.ParseDuration(config.OpenStack.RequestTimeout)
}

func (config Config) OpenStackConsoleMaxAge() (time.Duration, error) {
	if config.OpenStack.ConsoleMaxAge == "" {
		return 0, nil
	}
	return time.ParseDuration(config.OpenStack.ConsoleMaxAge)
}

func (config Config) UplinkDurations() (ttl, maxSampleAge, maxFutureSkew time.Duration, err error) {
	for _, value := range []struct {
		raw         string
		destination *time.Duration
	}{
		{raw: config.Uplink.TTL, destination: &ttl},
		{raw: config.Uplink.MaxSampleAge, destination: &maxSampleAge},
		{raw: config.Uplink.MaxFutureSkew, destination: &maxFutureSkew},
	} {
		if value.raw == "" {
			continue
		}
		parsed, parseErr := time.ParseDuration(value.raw)
		if parseErr != nil {
			return 0, 0, 0, parseErr
		}
		*value.destination = parsed
	}
	return ttl, maxSampleAge, maxFutureSkew, nil
}
