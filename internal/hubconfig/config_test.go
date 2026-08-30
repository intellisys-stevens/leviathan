package hubconfig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/miglens/internal/fleet"
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
creator_username = "owner-a@example.test"
agent_url = "https://agent-a.example.test"
agent_hostname = "gpu-agent-a"

[[instances]]
uuid = "22222222-2222-4222-8222-222222222222"
creator_username = "owner-b@example.test"
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
	if decision := policy.Evaluate(testInstance("11111111-1111-4111-8111-111111111111", "owner-a@example.test")); !decision.AgentProbeEligible {
		t.Fatalf("approved instance decision = %+v", decision)
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

func testInstance(uuid, creator string) fleet.Instance {
	return fleet.Instance{UUID: uuid, CreatorUsername: creator, CloudState: fleet.CloudStateActive}
}
