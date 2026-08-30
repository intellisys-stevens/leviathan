package openstackinventory

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"github.com/gophercloud/gophercloud/v2"
)

const (
	defaultMaxInstances   = 500
	defaultRequestTimeout = 15 * time.Second
)

// Config contains only non-secret controls for the Jetstream inventory
// adapter. Authentication material is read by Gophercloud from the standard
// OS_* environment variables and is never copied into this value.
type Config struct {
	AllowedProjectIDs   []string
	AllowedAuthHosts    []string
	AllowedComputeHosts []string
	MaxInstances        int
	RequestTimeout      time.Duration

	// HTTPClient is optional and exists primarily for injecting a trusted test
	// transport. Production callers should leave it nil to use Go's verified
	// system TLS roots.
	HTTPClient *http.Client

	CreatorResolver CreatorResolver
	Clock           func() time.Time
}

type environment struct {
	projectID    string
	region       string
	availability gophercloud.Availability
}

func (config Config) normalized() (Config, error) {
	if len(config.AllowedProjectIDs) == 0 {
		return Config{}, errors.New("OpenStack project allowlist is required")
	}
	if err := validateOpaqueAllowlist(config.AllowedProjectIDs); err != nil {
		return Config{}, fmt.Errorf("invalid OpenStack project allowlist: %w", err)
	}
	if len(config.AllowedAuthHosts) == 0 {
		return Config{}, errors.New("OpenStack auth host allowlist is required")
	}
	if len(config.AllowedComputeHosts) == 0 {
		return Config{}, errors.New("OpenStack compute host allowlist is required")
	}
	if err := validateAllowedHosts(config.AllowedAuthHosts); err != nil {
		return Config{}, fmt.Errorf("invalid OpenStack auth host allowlist: %w", err)
	}
	if err := validateAllowedHosts(config.AllowedComputeHosts); err != nil {
		return Config{}, fmt.Errorf("invalid OpenStack compute host allowlist: %w", err)
	}
	if config.MaxInstances == 0 {
		config.MaxInstances = defaultMaxInstances
	}
	if config.MaxInstances < 1 || config.MaxInstances > 10_000 {
		return Config{}, errors.New("OpenStack max instances must be between 1 and 10000")
	}
	if config.RequestTimeout == 0 {
		config.RequestTimeout = defaultRequestTimeout
	}
	if config.RequestTimeout < time.Second || config.RequestTimeout > time.Minute {
		return Config{}, errors.New("OpenStack request timeout must be between 1s and 1m")
	}
	if config.Clock == nil {
		config.Clock = func() time.Time { return time.Now().UTC() }
	}
	if config.CreatorResolver == nil {
		config.CreatorResolver = EmptyCreatorResolver{}
	}
	return config, nil
}

func environmentFromOS() (environment, error) {
	projectID := os.Getenv("OS_PROJECT_ID")
	if !validOpaqueIdentifier(projectID) {
		return environment{}, errors.New("OS_PROJECT_ID is required and must be an exact opaque identifier")
	}
	region := os.Getenv("OS_REGION_NAME")
	if !validDisplayToken(region, 128) {
		return environment{}, errors.New("OS_REGION_NAME is required and must not contain surrounding whitespace or control characters")
	}
	if os.Getenv("OS_SYSTEM_SCOPE") != "" {
		return environment{}, errors.New("OS_SYSTEM_SCOPE is not allowed for project-scoped inventory")
	}

	availability := gophercloud.AvailabilityPublic
	rawInterface := os.Getenv("OS_INTERFACE")
	if strings.TrimSpace(rawInterface) != rawInterface {
		return environment{}, errors.New("OS_INTERFACE must be public or internal")
	}
	switch raw := strings.ToLower(rawInterface); raw {
	case "", string(gophercloud.AvailabilityPublic):
	case string(gophercloud.AvailabilityInternal):
		availability = gophercloud.AvailabilityInternal
	default:
		return environment{}, errors.New("OS_INTERFACE must be public or internal")
	}
	return environment{projectID: projectID, region: region, availability: availability}, nil
}

func validateAllowedHosts(hosts []string) error {
	seen := make(map[string]struct{}, len(hosts))
	for _, host := range hosts {
		if host == "" || strings.TrimSpace(host) != host || strings.ContainsAny(host, "/?#@") {
			return errors.New("entries must be exact host or host:port values")
		}
		parsed, err := url.Parse("https://" + host)
		if err != nil || parsed.Host != host || parsed.Hostname() == "" {
			return errors.New("entries must be valid host or host:port values")
		}
		key := strings.ToLower(host)
		if _, duplicate := seen[key]; duplicate {
			return errors.New("duplicate host entry")
		}
		seen[key] = struct{}{}
	}
	return nil
}

func validateOpaqueAllowlist(values []string) error {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !validOpaqueIdentifier(value) {
			return errors.New("entries must be exact non-empty identifiers")
		}
		if _, duplicate := seen[value]; duplicate {
			return errors.New("duplicate identifier entry")
		}
		seen[value] = struct{}{}
	}
	return nil
}

func containsExact(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func validateHTTPSURL(raw, role string, allowedHosts []string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.Opaque != "" || parsed.RawPath != "" || parsed.ForceQuery || strings.Contains(raw, `\`) {
		return nil, fmt.Errorf("OpenStack %s endpoint is invalid", role)
	}
	if !strings.EqualFold(parsed.Scheme, "https") {
		return nil, fmt.Errorf("OpenStack %s endpoint must use HTTPS", role)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("OpenStack %s endpoint must not contain a query or fragment", role)
	}
	cleanedPath := strings.TrimSuffix(path.Clean(parsed.Path), "/")
	actualPath := strings.TrimSuffix(parsed.Path, "/")
	if cleanedPath != actualPath || strings.Contains(parsed.Path, "//") {
		return nil, fmt.Errorf("OpenStack %s endpoint path is invalid", role)
	}
	for _, allowed := range allowedHosts {
		if strings.EqualFold(parsed.Host, allowed) {
			return parsed, nil
		}
	}
	return nil, fmt.Errorf("OpenStack %s endpoint host is not allowlisted", role)
}

func validOpaqueIdentifier(value string) bool {
	return validDisplayToken(value, 256)
}

func validDisplayToken(value string, maxBytes int) bool {
	if value == "" || len(value) > maxBytes || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}
