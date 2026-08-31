package hubconfig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/fleet"
)

const validConfig = `
listen = "127.0.0.1:1398"
refresh_interval = "30s"
agent_timeout = "8s"
agent_stale_after = "45s"
max_concurrent_agents = 2
nidhogg_dashboard_url = "https://nidhogg.example.test/"

[openstack]
allowed_project_ids = ["project-test"]
allowed_auth_hosts = ["identity.example.test:5000"]
allowed_compute_hosts = ["compute.example.test:8774"]
max_instances = 100
request_timeout = "10s"

[[instances]]
uuid = "11111111-1111-4111-8111-111111111111"
creator_id = "nova-user-a"
creator_username = "owner-a@example.test"
agent_url = "https://agent-a.example.test"
agent_hostname = "gpu-agent-a"

[[instances]]
uuid = "22222222-2222-4222-8222-222222222222"
creator_id = "nova-user-b"
creator_username = "owner-b@example.test"

[[creators]]
creator_id = "nova-user-b"
creator_username = "owner-b@example.test"
telemetry_enabled = false
`

func TestLoadValidNonSecretConfig(t *testing.T) {
	config := loadText(t, validConfig)
	if config.Listen != DefaultListen || config.RefreshInterval != 30*time.Second || config.AgentTimeout != 8*time.Second {
		t.Fatalf("timing config = %+v", config)
	}
	policy, err := config.Policy()
	if err != nil {
		t.Fatalf("Policy() error = %v", err)
	}
	if decision := policy.Evaluate(testInstance("11111111-1111-4111-8111-111111111111", "nova-user-a", "untrusted-metadata@example.test")); !decision.AgentProbeEligible || decision.CreatorUsername != "owner-a@example.test" {
		t.Fatalf("approved instance decision = %+v", decision)
	}
	if decision := policy.Evaluate(testInstance("33333333-3333-4333-8333-333333333333", "nova-user-b", "untrusted-metadata@example.test")); !decision.Allowlisted || decision.AgentProbeEligible || decision.CreatorUsername != "owner-b@example.test" {
		t.Fatalf("approved creator decision = %+v", decision)
	}
	if decision := policy.Evaluate(testInstance("22222222-2222-4222-8222-222222222222", "nova-user-b", "untrusted-metadata@example.test")); !decision.Allowlisted || decision.AgentProbeEligible || decision.Reason != fleet.PolicyAgentNotConfigured {
		t.Fatalf("explicit instance did not override creator telemetry = %+v", decision)
	}
	bindings := config.AgentBindings()
	if len(bindings) != 1 || bindings["11111111-1111-4111-8111-111111111111"].ExpectedHostname != "gpu-agent-a" {
		t.Fatalf("bindings = %+v", bindings)
	}
	timeout, err := config.OpenStackRequestTimeout()
	if err != nil || timeout != 10*time.Second {
		t.Fatalf("OpenStackRequestTimeout() = %s, %v", timeout, err)
	}
}

func TestLoadLegacyExactOnlyConfigPreservesBehavior(t *testing.T) {
	legacyConfig := strings.Split(validConfig, "\n[[creators]]")[0] + "\n"
	config := loadText(t, legacyConfig)
	policy, err := config.Policy()
	if err != nil {
		t.Fatal(err)
	}
	bound := policy.Evaluate(testInstance("11111111-1111-4111-8111-111111111111", "nova-user-a", "advisory@example.test"))
	if !bound.AgentProbeEligible || bound.Reason != fleet.PolicyAllowed {
		t.Fatalf("legacy bound exact decision = %+v", bound)
	}
	unbound := policy.Evaluate(testInstance("22222222-2222-4222-8222-222222222222", "nova-user-b", "advisory@example.test"))
	if !unbound.Allowlisted || unbound.AgentProbeEligible || unbound.Reason != fleet.PolicyAgentNotConfigured {
		t.Fatalf("legacy unbound exact decision = %+v", unbound)
	}
	unknown := policy.Evaluate(testInstance("33333333-3333-4333-8333-333333333333", "nova-user-b", "advisory@example.test"))
	if unknown.Allowlisted || unknown.Reason != fleet.PolicyNotAllowlisted {
		t.Fatalf("legacy unknown decision = %+v", unknown)
	}
	if bindings := config.AgentBindings(); len(bindings) != 1 {
		t.Fatalf("legacy bindings = %#v", bindings)
	}
}

func TestLoadRejectsUnknownOrSecretShapedFields(t *testing.T) {
	for _, addition := range []string{
		"\npassword = \"secret\"\n",
		"\nopenrc = \"/tmp/cloud.sh\"\n",
		"\napi_token = \"secret\"\n",
	} {
		path := writeConfig(t, validConfig+addition)
		_, err := Load(path)
		if err == nil {
			t.Fatalf("Load() accepted unknown field in %q", addition)
		}
		if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "/tmp/cloud.sh") {
			t.Fatalf("Load() error leaked rejected value: %v", err)
		}
	}
}

func TestLoadRejectsUnsafeScopeAndBindings(t *testing.T) {
	tests := []struct {
		name string
		old  string
		new  string
	}{
		{name: "non-loopback", old: `listen = "127.0.0.1:1398"`, new: `listen = "0.0.0.0:1398"`},
		{name: "http nidhogg", old: `https://nidhogg.example.test/`, new: `http://nidhogg.example.test/`},
		{name: "missing project allowlist", old: `allowed_project_ids = ["project-test"]`, new: `allowed_project_ids = []`},
		{name: "wildcard creator", old: `owner-a@example.test`, new: `*@example.test`},
		{name: "missing creator ID", old: `creator_id = "nova-user-a"`, new: `creator_id = ""`},
		{name: "http agent", old: `https://agent-a.example.test`, new: `http://agent-a.example.test`},
		{name: "missing hostname", old: `agent_hostname = "gpu-agent-a"`, new: `agent_hostname = ""`},
		{name: "duplicate UUID", old: `uuid = "22222222-2222-4222-8222-222222222222"`, new: `uuid = "11111111-1111-4111-8111-111111111111"`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			text := strings.Replace(validConfig, test.old, test.new, 1)
			if _, err := Load(writeConfig(t, text)); err == nil {
				t.Fatal("Load() error = nil, want fail-closed rejection")
			}
		})
	}
}

func TestLoadCreatorRulesDefaultTelemetryDisabled(t *testing.T) {
	text := validConfig + `

[[creators]]
creator_id = "nova-user-c"
creator_username = "owner-c@example.test"
`
	config := loadText(t, text)
	policy, err := config.Policy()
	if err != nil {
		t.Fatalf("Policy() error = %v", err)
	}
	decision := policy.Evaluate(testInstance("33333333-3333-4333-8333-333333333333", "nova-user-c", "advisory@example.test"))
	if !decision.Allowlisted || decision.AgentProbeEligible || decision.Reason != fleet.PolicyAgentNotConfigured || decision.CreatorUsername != "owner-c@example.test" {
		t.Fatalf("default-disabled creator decision = %+v", decision)
	}
}

func TestConsoleMetricsEnablesUnboundExactInstances(t *testing.T) {
	text := strings.Replace(validConfig, `request_timeout = "10s"`, `request_timeout = "10s"
console_metrics_enabled = true
console_lines = 120
console_max_age = "4m"
console_max_response_bytes = 131072`, 1)
	text = strings.Replace(text, `telemetry_enabled = false`, `telemetry_enabled = true`, 1)
	config := loadText(t, text)
	policy, err := config.Policy()
	if err != nil {
		t.Fatal(err)
	}
	decision := policy.Evaluate(testInstance("22222222-2222-4222-8222-222222222222", "nova-user-b", "advisory@example.test"))
	if !decision.AgentProbeEligible || decision.Reason != fleet.PolicyAllowed {
		t.Fatalf("console-enabled exact instance decision = %+v", decision)
	}
	dynamic := policy.Evaluate(testInstance("33333333-3333-4333-8333-333333333333", "nova-user-b", "advisory@example.test"))
	if !dynamic.AgentProbeEligible || dynamic.Reason != fleet.PolicyAllowed {
		t.Fatalf("console-enabled creator instance decision = %+v", dynamic)
	}
	maxAge, err := config.OpenStackConsoleMaxAge()
	if err != nil || maxAge != 4*time.Minute {
		t.Fatalf("OpenStackConsoleMaxAge() = %v, %v", maxAge, err)
	}
}

func TestConsoleTuningRequiresEnabledBoundedConfiguration(t *testing.T) {
	for _, addition := range []string{
		"\nconsole_lines = 100\n",
		"\nconsole_metrics_enabled = true\nconsole_lines = 201\n",
		"\nconsole_metrics_enabled = true\nconsole_max_age = \"1s\"\n",
		"\nconsole_metrics_enabled = true\nconsole_max_response_bytes = 1024\n",
	} {
		text := strings.Replace(validConfig, `request_timeout = "10s"`, `request_timeout = "10s"`+addition, 1)
		if _, err := Load(writeConfig(t, text)); err == nil {
			t.Fatalf("Load() accepted invalid console configuration %q", addition)
		}
	}
}

func TestUplinkConfigurationReferencesEnvironmentWithoutReadingSecret(t *testing.T) {
	t.Setenv("LEVIATHAN_TEST_OWNER_B_TOKEN", strings.Repeat("s", 48))
	text := strings.Replace(validConfig, `[[instances]]`, `[uplink]
enabled = true
ttl = "90s"
max_sample_age = "90s"
max_future_skew = "20s"
max_body_bytes = 1048576
max_entries = 200
max_retained_bytes = 16777216
max_creator_retained_bytes = 4194304
max_concurrent_requests = 3

[[instances]]`, 1)
	text = strings.Replace(text, `creator_username = "owner-b@example.test"
telemetry_enabled = false`, `creator_username = "owner-b@example.test"
telemetry_enabled = true
uplink_token_env = "LEVIATHAN_TEST_OWNER_B_TOKEN"`, 1)
	config := loadText(t, text)
	ttl, maxAge, futureSkew, err := config.UplinkDurations()
	if err != nil || ttl != 90*time.Second || maxAge != 90*time.Second || futureSkew != 20*time.Second {
		t.Fatalf("UplinkDurations() = %v %v %v, %v", ttl, maxAge, futureSkew, err)
	}
	if config.Uplink.MaxRetainedBytes != 16777216 || config.Uplink.MaxCreatorRetainedBytes != 4194304 || config.Uplink.MaxConcurrentRequests != 3 {
		t.Fatalf("uplink resource limits = %+v", config.Uplink)
	}
	policy, err := config.Policy()
	if err != nil {
		t.Fatal(err)
	}
	decision := policy.Evaluate(testInstance("22222222-2222-4222-8222-222222222222", "nova-user-b", "advisory@example.test"))
	if !decision.AgentProbeEligible {
		t.Fatalf("uplink did not enable matching explicit instance: %+v", decision)
	}

	boundary := strings.Replace(text, "max_body_bytes = 1048576", "max_body_bytes = 4194304", 1)
	boundary = strings.Replace(boundary, "max_concurrent_requests = 3", "max_concurrent_requests = 64", 1)
	boundary = strings.Replace(boundary, "max_retained_bytes = 16777216", "max_retained_bytes = 268435456", 1)
	boundary = strings.Replace(boundary, "max_creator_retained_bytes = 4194304", "max_creator_retained_bytes = 67108864", 1)
	if _, err := Load(writeConfig(t, boundary)); err != nil {
		t.Fatalf("exact 256 MiB in-flight boundary error = %v", err)
	}
	overBudget := strings.Replace(boundary, "max_body_bytes = 4194304", "max_body_bytes = 4194305", 1)
	if _, err := Load(writeConfig(t, overBudget)); err == nil {
		t.Fatal("Load() accepted an in-flight raw-body budget above 256 MiB")
	}
}

func TestUplinkConfigurationFailsClosed(t *testing.T) {
	legacyTokenEnvironment := "MIG" + "LENS_TEST_TOKEN"
	base := strings.Replace(validConfig, `[[instances]]`, `[uplink]
enabled = true

[[instances]]`, 1)
	crossCreator := strings.Replace(base, `telemetry_enabled = false`, `telemetry_enabled = true`, 1) + `

[[creators]]
creator_id = "nova-user-c"
creator_username = "owner-c@example.test"
telemetry_enabled = true
uplink_token_env = "LEVIATHAN_TEST_OWNER_C_TOKEN"
`
	tests := []struct {
		name string
		text string
	}{
		{name: "enabled without token reference", text: base},
		{name: "dynamic telemetry without route", text: strings.Replace(validConfig, `telemetry_enabled = false`, `telemetry_enabled = true`, 1)},
		{name: "one creator token does not authorize another creator route", text: crossCreator},
		{name: "token reference while disabled", text: strings.Replace(validConfig, `telemetry_enabled = false`, `telemetry_enabled = true
uplink_token_env = "LEVIATHAN_TEST_TOKEN"`, 1)},
		{name: "invalid token environment", text: strings.Replace(base, `telemetry_enabled = false`, `telemetry_enabled = true
uplink_token_env = "bad-token-env"`, 1)},
		{name: "legacy token environment", text: strings.Replace(base, `telemetry_enabled = false`, `telemetry_enabled = true
uplink_token_env = "`+legacyTokenEnvironment+`"`, 1)},
		{name: "token on disabled creator", text: strings.Replace(base, `telemetry_enabled = false`, `telemetry_enabled = false
uplink_token_env = "LEVIATHAN_TEST_TOKEN"`, 1)},
		{name: "unknown inline token", text: strings.Replace(base, `[uplink]`, `[uplink]
token = "`+strings.Repeat("secret", 8)+`"`, 1)},
		{name: "oversized body", text: strings.Replace(base, `[uplink]`, `[uplink]
max_body_bytes = 40000000`, 1)},
		{name: "creator retained below body", text: strings.Replace(base, `[uplink]`, `[uplink]
max_creator_retained_bytes = 4096`, 1)},
		{name: "creator retained above global", text: strings.Replace(base, `[uplink]`, `[uplink]
max_creator_retained_bytes = 134217728
max_retained_bytes = 67108864`, 1)},
		{name: "oversized retained budget", text: strings.Replace(base, `[uplink]`, `[uplink]
max_retained_bytes = 2147483648`, 1)},
		{name: "excessive concurrency", text: strings.Replace(base, `[uplink]`, `[uplink]
max_concurrent_requests = 65`, 1)},
		{name: "TTL shorter than replay window", text: strings.Replace(base, `[uplink]`, `[uplink]
ttl = "30s"
max_sample_age = "1m"`, 1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Load(writeConfig(t, test.text)); err == nil {
				t.Fatal("Load() error = nil, want rejection")
			} else if strings.Contains(err.Error(), strings.Repeat("secret", 3)) {
				t.Fatal("Load() error leaked rejected token")
			}
		})
	}
}

func TestLoadRejectsDuplicateOrConflictingCreatorRules(t *testing.T) {
	tests := []struct {
		name     string
		addition string
	}{
		{
			name: "duplicate creator ID",
			addition: `

[[creators]]
creator_id = "nova-user-b"
creator_username = "owner-b@example.test"
telemetry_enabled = false
`,
		},
		{
			name: "creator ID wildcard",
			addition: `

[[creators]]
creator_id = "nova-user-*"
creator_username = "owner-c@example.test"
`,
		},
		{
			name: "creator username wildcard",
			addition: `

[[creators]]
creator_id = "nova-user-c"
creator_username = "*@example.test"
`,
		},
		{
			name: "creator label conflicts with explicit instance",
			addition: `

[[creators]]
creator_id = "nova-user-a"
creator_username = "different-owner@example.test"
`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Load(writeConfig(t, validConfig+test.addition)); err == nil {
				t.Fatal("Load() error = nil, want fail-closed rejection")
			}
		})
	}
}

func TestPolicyRejectsProgrammaticCreatorDuplicates(t *testing.T) {
	config := Config{Creators: []Creator{
		{CreatorID: "nova-user-a", CreatorUsername: "owner-a@example.test"},
		{CreatorID: "nova-user-a", CreatorUsername: "owner-a@example.test"},
	}}
	if _, err := config.Policy(); err == nil {
		t.Fatal("Policy() error = nil, want duplicate creator rejection")
	}
}

func loadText(t *testing.T, text string) Config {
	t.Helper()
	config, err := Load(writeConfig(t, text))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	return config
}

func writeConfig(t *testing.T, text string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "hub.toml")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

func testInstance(uuid, creatorID, creator string) fleet.Instance {
	return fleet.Instance{UUID: uuid, CreatorID: creatorID, CreatorUsername: creator, CloudState: fleet.CloudStateActive}
}
