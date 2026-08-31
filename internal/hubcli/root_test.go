package hubcli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/hubconfig"
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

func TestExecuteRejectsLegacyEnvironment(t *testing.T) {
	legacyName := "MIG" + "LENS_HUB_CONFIG"
	t.Setenv(legacyName, "/tmp/legacy-hub.toml")
	var stdout, stderr bytes.Buffer
	err := Execute(context.Background(), &stdout, &stderr, []string{"version", "--json"})
	if err == nil || !strings.Contains(err.Error(), legacyName) || !strings.Contains(err.Error(), "LEVIATHAN_HUB_CONFIG") {
		t.Fatalf("Execute(version) legacy environment error = %v", err)
	}
	if stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatalf("legacy environment rejection wrote output: stdout=%q stderr=%q", stdout.String(), stderr.String())
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
	t.Setenv("LEVIATHAN_TEST_CREATOR_TOKEN", secret)
	config := hubconfig.Config{Creators: []hubconfig.Creator{{
		CreatorID: "nova-user-a", UplinkTokenEnv: "LEVIATHAN_TEST_CREATOR_TOKEN",
	}}}
	tokens, err := loadCreatorTokens(config)
	if err != nil {
		t.Fatal(err)
	}
	if len(tokens) != 1 || tokens["nova-user-a"] != secret {
		t.Fatalf("creator token mapping = %#v", tokens)
	}

	config.Creators[0].UplinkTokenEnv = "LEVIATHAN_TEST_MISSING_TOKEN"
	_, err = loadCreatorTokens(config)
	if err == nil || !bytes.Contains([]byte(err.Error()), []byte("LEVIATHAN_TEST_MISSING_TOKEN")) {
		t.Fatalf("missing token error = %v", err)
	}
	if bytes.Contains([]byte(err.Error()), []byte(secret)) {
		t.Fatal("missing token error leaked a bearer token")
	}
}

func TestHubHTTPServicesUseSeparateListenersAndShutdownTogether(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	dashboard := http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	})
	uplink := http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusAccepted)
	})
	services, err := listenHubHTTPServices(ctx, "127.0.0.1:0", dashboard, "127.0.0.1:0", uplink)
	if err != nil {
		t.Fatal(err)
	}
	if len(services) != 2 || services[0].name != "dashboard" || services[1].name != "uplink" {
		t.Fatalf("services = %#v", services)
	}
	if services[0].listener.Addr().String() == services[1].listener.Addr().String() {
		t.Fatal("dashboard and uplink unexpectedly share one listener")
	}

	done := make(chan error, 1)
	go func() { done <- serveHubHTTPServices(ctx, services) }()
	for index, want := range []int{http.StatusNoContent, http.StatusAccepted} {
		response, requestErr := waitForHTTP("http://" + services[index].listener.Addr().String())
		if requestErr != nil {
			cancel()
			<-done
			t.Fatalf("service %d request error = %v", index, requestErr)
		}
		_ = response.Body.Close()
		if response.StatusCode != want {
			cancel()
			<-done
			t.Fatalf("service %d status = %d, want %d", index, response.StatusCode, want)
		}
	}

	addresses := []string{services[0].listener.Addr().String(), services[1].listener.Addr().String()}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveHubHTTPServices() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Hub HTTP services did not shut down together")
	}
	for _, address := range addresses {
		connection, dialErr := net.DialTimeout("tcp", address, 100*time.Millisecond)
		if dialErr == nil {
			_ = connection.Close()
			t.Fatalf("listener %s remained open after shutdown", address)
		}
	}
}

func TestHubHTTPServiceFailureClosesPeerListener(t *testing.T) {
	ctx := context.Background()
	handler := http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) { writer.WriteHeader(http.StatusNoContent) })
	services, err := listenHubHTTPServices(ctx, "127.0.0.1:0", handler, "127.0.0.1:0", handler)
	if err != nil {
		t.Fatal(err)
	}
	peerAddress := services[1].listener.Addr().String()
	if err := services[0].listener.Close(); err != nil {
		t.Fatal(err)
	}
	if err := serveHubHTTPServices(ctx, services); err == nil {
		t.Fatal("serveHubHTTPServices() error = nil after listener failure")
	}
	connection, dialErr := net.DialTimeout("tcp", peerAddress, 100*time.Millisecond)
	if dialErr == nil {
		_ = connection.Close()
		t.Fatal("peer listener remained open after sibling failure")
	}
}

func TestHubHTTPServerRoutesAsteriskOptionsToHandler(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	handled := make(chan string, 1)
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		handled <- request.RequestURI
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.WriteHeader(http.StatusNotFound)
	})
	services, err := listenHubHTTPServices(ctx, "127.0.0.1:0", handler, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !services[0].server.DisableGeneralOptionsHandler {
		t.Fatal("general OPTIONS handler is enabled")
	}
	done := make(chan error, 1)
	go func() { done <- serveHubHTTPServices(ctx, services) }()

	connection, err := net.DialTimeout("tcp", services[0].listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := fmt.Fprintf(connection, "OPTIONS * HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", services[0].listener.Addr()); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodOptions})
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("OPTIONS * response = status %d headers %v", response.StatusCode, response.Header)
	}
	if requestURI := <-handled; requestURI != "*" {
		t.Fatalf("handler RequestURI = %q, want *", requestURI)
	}

	cancel()
	if err := <-done; err != nil {
		t.Fatalf("serveHubHTTPServices() error = %v", err)
	}
}

func waitForHTTP(target string) (*http.Response, error) {
	client := &http.Client{Timeout: 200 * time.Millisecond}
	deadline := time.Now().Add(time.Second)
	for {
		response, err := client.Get(target)
		if err == nil {
			return response, nil
		}
		if time.Now().After(deadline) {
			return nil, err
		}
		time.Sleep(10 * time.Millisecond)
	}
}
