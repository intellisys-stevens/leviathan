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
	"strings"
	"time"

	"github.com/intellisys-stevens/miglens/internal/agentclient"
	localconfig "github.com/intellisys-stevens/miglens/internal/config"
	"github.com/intellisys-stevens/miglens/internal/fleet"
	"github.com/pelletier/go-toml/v2"
)

const DefaultListen = "127.0.0.1:1398"

type OpenStack struct {
	AllowedProjectIDs   []string `toml:"allowed_project_ids"`
	AllowedAuthHosts    []string `toml:"allowed_auth_hosts"`
	AllowedComputeHosts []string `toml:"allowed_compute_hosts"`
	MaxInstances        int      `toml:"max_instances"`
	RequestTimeout      string   `toml:"request_timeout"`
}

type Instance struct {
	UUID            string `toml:"uuid"`
	CreatorUsername string `toml:"creator_username"`
	AgentURL        string `toml:"agent_url"`
	AgentHostname   string `toml:"agent_hostname"`
}

type Config struct {
	Listen              string        `toml:"listen"`
	RefreshInterval     time.Duration `toml:"-"`
	AgentTimeout        time.Duration `toml:"-"`
	AgentStaleAfter     time.Duration `toml:"-"`
	MaxConcurrentAgents int           `toml:"max_concurrent_agents"`
	NidhoggDashboardURL string        `toml:"nidhogg_dashboard_url"`
	OpenStack           OpenStack     `toml:"openstack"`
	Instances           []Instance    `toml:"instances"`
}

type fileConfig struct {
	Listen              string     `toml:"listen"`
	RefreshInterval     string     `toml:"refresh_interval"`
	AgentTimeout        string     `toml:"agent_timeout"`
	AgentStaleAfter     string     `toml:"agent_stale_after"`
	MaxConcurrentAgents int        `toml:"max_concurrent_agents"`
	NidhoggDashboardURL string     `toml:"nidhogg_dashboard_url"`
	OpenStack           OpenStack  `toml:"openstack"`
	Instances           []Instance `toml:"instances"`
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
		Instances:           append([]Instance(nil), file.Instances...),
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

	allowlist := make(map[string]string, len(config.Instances))
	bindings := make(map[string]agentclient.Binding)
	for _, instance := range config.Instances {
		if _, duplicate := allowlist[instance.UUID]; duplicate {
			return errors.New("instance UUIDs must be unique")
		}
		allowlist[instance.UUID] = instance.CreatorUsername
		if (instance.AgentURL == "") != (instance.AgentHostname == "") {
			return errors.New("agent_url and agent_hostname must be configured together")
		}
		if instance.AgentURL != "" {
			bindings[instance.UUID] = agentclient.Binding{BaseURL: instance.AgentURL, ExpectedHostname: instance.AgentHostname}
		}
	}
	if _, err := fleet.NewPolicy(allowlist); err != nil {
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

func (config Config) Policy() (fleet.Policy, error) {
	entries := make(map[string]string, len(config.Instances))
	for _, instance := range config.Instances {
		entries[instance.UUID] = instance.CreatorUsername
	}
	return fleet.NewPolicy(entries)
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
