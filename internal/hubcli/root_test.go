package hubcli

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/intellisys-stevens/miglens/internal/hubconfig"
)

func TestVersionDoesNotRequireOpenStackOrConfig(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := Execute(context.Background(), &stdout, &stderr, []string{"version", "--json"}); err != nil {
		t.Fatalf("Execute(version) error = %v", err)
	}
	var info map[string]string
	if err := json.Unmarshal(stdout.Bytes(), &info); err != nil {
		t.Fatalf("version JSON error = %v", err)
	}
	if info["version"] == "" || info["commit"] == "" || info["buildDate"] == "" {
		t.Fatalf("version info = %v", info)
	}
}

func TestInventoryRequiresConfigWithoutReadingOpenStackEnvironment(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := Execute(context.Background(), &stdout, &stderr, []string{"inventory"})
	if err == nil {
		t.Fatal("Execute(inventory) error = nil, want missing config rejection")
	}
	if stdout.Len() != 0 {
		t.Fatalf("inventory wrote unexpected output: %q", stdout.String())
	}
}

func TestLoadCreatorTokensUsesOnlyNamedEnvironmentVariables(t *testing.T) {
	secret := "test-secret-value-that-is-long-enough-for-uplink"
	t.Setenv("MIGLENS_TEST_CREATOR_TOKEN", secret)
	config := hubconfig.Config{Creators: []hubconfig.Creator{{
		CreatorID: "nova-user-a", UplinkTokenEnv: "MIGLENS_TEST_CREATOR_TOKEN",
	}}}
	tokens, err := loadCreatorTokens(config)
	if err != nil {
		t.Fatal(err)
	}
	if len(tokens) != 1 || tokens["nova-user-a"] != secret {
		t.Fatalf("creator token mapping = %#v", tokens)
	}

	config.Creators[0].UplinkTokenEnv = "MIGLENS_TEST_MISSING_TOKEN"
	_, err = loadCreatorTokens(config)
	if err == nil || !bytes.Contains([]byte(err.Error()), []byte("MIGLENS_TEST_MISSING_TOKEN")) {
		t.Fatalf("missing token error = %v", err)
	}
	if bytes.Contains([]byte(err.Error()), []byte(secret)) {
		t.Fatal("missing token error leaked a bearer token")
	}
}
