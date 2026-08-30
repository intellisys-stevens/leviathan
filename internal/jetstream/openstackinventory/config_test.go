package openstackinventory

import (
	"strings"
	"testing"
	"time"

	"github.com/gophercloud/gophercloud/v2"
)

func TestConfigRequiresClosedHostAndInstanceBounds(t *testing.T) {
	tests := []struct {
		name   string
		config Config
	}{
		{name: "missing project allowlist", config: Config{AllowedAuthHosts: []string{"identity.example.test"}, AllowedComputeHosts: []string{"compute.example.test"}}},
		{name: "missing auth hosts", config: Config{AllowedProjectIDs: []string{testProjectID}, AllowedComputeHosts: []string{"compute.example.test"}}},
		{name: "missing compute hosts", config: Config{AllowedProjectIDs: []string{testProjectID}, AllowedAuthHosts: []string{"identity.example.test"}}},
		{name: "host contains scheme", config: Config{AllowedProjectIDs: []string{testProjectID}, AllowedAuthHosts: []string{"https://identity.example.test"}, AllowedComputeHosts: []string{"compute.example.test"}}},
		{name: "duplicate host", config: Config{AllowedProjectIDs: []string{testProjectID}, AllowedAuthHosts: []string{"identity.example.test", "IDENTITY.example.test"}, AllowedComputeHosts: []string{"compute.example.test"}}},
		{name: "duplicate project", config: Config{AllowedProjectIDs: []string{testProjectID, testProjectID}, AllowedAuthHosts: []string{"identity.example.test"}, AllowedComputeHosts: []string{"compute.example.test"}}},
		{name: "negative instance maximum", config: Config{AllowedProjectIDs: []string{testProjectID}, AllowedAuthHosts: []string{"identity.example.test"}, AllowedComputeHosts: []string{"compute.example.test"}, MaxInstances: -1}},
		{name: "excessive instance maximum", config: Config{AllowedProjectIDs: []string{testProjectID}, AllowedAuthHosts: []string{"identity.example.test"}, AllowedComputeHosts: []string{"compute.example.test"}, MaxInstances: 10_001}},
		{name: "short timeout", config: Config{AllowedProjectIDs: []string{testProjectID}, AllowedAuthHosts: []string{"identity.example.test"}, AllowedComputeHosts: []string{"compute.example.test"}, RequestTimeout: time.Millisecond}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := test.config.normalized(); err == nil {
				t.Fatal("Config.normalized() error = nil, want fail-closed rejection")
			}
		})
	}
}

func TestConfigDefaultsAreBounded(t *testing.T) {
	config, err := (Config{
		AllowedProjectIDs:   []string{testProjectID},
		AllowedAuthHosts:    []string{"identity.example.test:5000"},
		AllowedComputeHosts: []string{"compute.example.test:8774"},
	}).normalized()
	if err != nil {
		t.Fatalf("Config.normalized() error = %v", err)
	}
	if config.MaxInstances != defaultMaxInstances || config.RequestTimeout != defaultRequestTimeout {
		t.Fatalf("defaults = max %d timeout %s", config.MaxInstances, config.RequestTimeout)
	}
	if config.CreatorResolver == nil || config.Clock == nil {
		t.Fatal("safe resolver and clock defaults were not installed")
	}
}

func TestEnvironmentRequiresProjectRegionAndNonAdminInterface(t *testing.T) {
	setEnvironment := func(project, region, availability, systemScope string) {
		t.Helper()
		t.Setenv("OS_PROJECT_ID", project)
		t.Setenv("OS_REGION_NAME", region)
		t.Setenv("OS_INTERFACE", availability)
		t.Setenv("OS_SYSTEM_SCOPE", systemScope)
	}

	setEnvironment(testProjectID, "RegionOne", "public", "")
	environment, err := environmentFromOS()
	if err != nil {
		t.Fatalf("environmentFromOS() error = %v", err)
	}
	if environment.projectID != testProjectID || environment.region != "RegionOne" || environment.availability != gophercloud.AvailabilityPublic {
		t.Fatalf("environment = %+v", environment)
	}

	setEnvironment(testProjectID, "RegionOne", "internal", "")
	environment, err = environmentFromOS()
	if err != nil || environment.availability != gophercloud.AvailabilityInternal {
		t.Fatalf("internal environment = %+v, error = %v", environment, err)
	}

	for _, test := range []struct {
		name, project, region, availability, systemScope string
	}{
		{name: "missing project", region: "RegionOne", availability: "public"},
		{name: "missing region", project: testProjectID, availability: "public"},
		{name: "admin interface", project: testProjectID, region: "RegionOne", availability: "admin"},
		{name: "interface whitespace", project: testProjectID, region: "RegionOne", availability: " public "},
		{name: "system scope", project: testProjectID, region: "RegionOne", availability: "public", systemScope: "all"},
	} {
		t.Run(test.name, func(t *testing.T) {
			setEnvironment(test.project, test.region, test.availability, test.systemScope)
			if _, err := environmentFromOS(); err == nil {
				t.Fatal("environmentFromOS() error = nil, want rejection")
			}
		})
	}
}

func TestHTTPSHostAllowlistIsExact(t *testing.T) {
	allowed := []string{"identity.example.test:5000"}
	if _, err := validateHTTPSURL("https://identity.example.test:5000/v3", "auth", allowed); err != nil {
		t.Fatalf("validateHTTPSURL() valid endpoint error = %v", err)
	}
	for _, raw := range []string{
		"http://identity.example.test:5000/v3",
		"https://other.example.test:5000/v3",
		"https://identity.example.test/v3",
		"https://user@identity.example.test:5000/v3",
		"https://identity.example.test:5000/v3?token=forbidden",
	} {
		t.Run(raw, func(t *testing.T) {
			_, err := validateHTTPSURL(raw, "auth", allowed)
			if err == nil {
				t.Fatal("validateHTTPSURL() error = nil, want rejection")
			}
			if strings.Contains(err.Error(), raw) {
				t.Fatal("endpoint validation error retained the rejected URL")
			}
		})
	}
}
