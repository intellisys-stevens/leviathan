// Package hubcli wires the standalone MIGLens fleet controller. Its OpenStack
// access is read-only; an explicitly enabled endpoint may receive authenticated
// telemetry from agents. It intentionally does not start the local collector.
package hubcli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/intellisys-stevens/miglens/internal/agentclient"
	"github.com/intellisys-stevens/miglens/internal/fleet"
	"github.com/intellisys-stevens/miglens/internal/fleetapi"
	"github.com/intellisys-stevens/miglens/internal/fleettelemetry"
	"github.com/intellisys-stevens/miglens/internal/fleetuplink"
	"github.com/intellisys-stevens/miglens/internal/hubconfig"
	"github.com/intellisys-stevens/miglens/internal/jetstream/consolemetrics"
	"github.com/intellisys-stevens/miglens/internal/jetstream/openstackinventory"
	"github.com/intellisys-stevens/miglens/internal/model"
	"github.com/intellisys-stevens/miglens/internal/webui"
	"github.com/spf13/cobra"
)

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

type application struct {
	stdout     io.Writer
	stderr     io.Writer
	configPath string
}

func Execute(ctx context.Context, stdout, stderr io.Writer, args []string) error {
	app := &application{stdout: stdout, stderr: stderr}
	root := app.command()
	root.SetArgs(args)
	root.SetOut(stdout)
	root.SetErr(stderr)
	return root.ExecuteContext(ctx)
}

func (app *application) command() *cobra.Command {
	root := &cobra.Command{
		Use:           "miglens-hub",
		Short:         "Cloud-read-only multi-platform MIGLens controller",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.PersistentFlags().StringVar(&app.configPath, "config", "", "required non-secret hub TOML configuration")
	root.AddCommand(app.inventoryCommand(), app.serveCommand(), versionCommand(app.stdout))
	return root
}

func (app *application) inventoryCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "inventory",
		Short: "Print the sanitized Jetstream inventory as JSON",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			config, err := app.loadConfig()
			if err != nil {
				return err
			}
			inventory, err := newInventory(command.Context(), config)
			if err != nil {
				return err
			}
			observation, err := inventory.List(command.Context())
			if err != nil {
				return errors.New("Jetstream inventory request failed")
			}
			encoder := json.NewEncoder(app.stdout)
			encoder.SetIndent("", "  ")
			return encoder.Encode(observation)
		},
	}
}

func (app *application) serveCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "serve",
		Short: "Serve the Yggdrasill dashboard and optional telemetry uplink",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			config, err := app.loadConfig()
			if err != nil {
				return err
			}
			inventory, err := newInventory(command.Context(), config)
			if err != nil {
				return err
			}
			projectID := os.Getenv("OS_PROJECT_ID")
			var uplinkRegistry *fleetuplink.Registry
			var creatorTokens map[string]string
			if config.Uplink.Enabled {
				ttl, maxSampleAge, maxFutureSkew, durationErr := config.UplinkDurations()
				if durationErr != nil {
					return durationErr
				}
				uplinkRegistry, err = fleetuplink.New(fleetuplink.Config{
					TTL:              ttl,
					MaxSampleAge:     maxSampleAge,
					MaxFutureSkew:    maxFutureSkew,
					MaxBodyBytes:     config.Uplink.MaxBodyBytes,
					MaxEntries:       config.Uplink.MaxEntries,
					MaxRetainedBytes: config.Uplink.MaxRetainedBytes,
					MaxCreatorBytes:  config.Uplink.MaxCreatorRetainedBytes,
				})
				if err != nil {
					return err
				}
				creatorTokens, err = loadCreatorTokens(config)
				if err != nil {
					return err
				}
			}

			bindings := config.AgentBindings()
			agents, err := agentclient.New(bindings, agentclient.Options{Timeout: config.AgentTimeout})
			if err != nil {
				return err
			}
			var consoleSource fleet.AgentSource
			if config.OpenStack.ConsoleMetricsEnabled {
				consoleMaxAge, parseErr := config.OpenStackConsoleMaxAge()
				if parseErr != nil {
					return parseErr
				}
				console, consoleErr := consolemetrics.New(inventory, consolemetrics.Options{
					Lines:           config.OpenStack.ConsoleLines,
					MaxAge:          consoleMaxAge,
					MaxConsoleBytes: int(config.OpenStack.ConsoleMaxResponseBytes),
				})
				if consoleErr != nil {
					return consoleErr
				}
				consoleSource = console
			}
			exactUUIDs := make([]string, 0, len(bindings))
			for instanceUUID := range bindings {
				exactUUIDs = append(exactUUIDs, instanceUUID)
			}
			telemetry, err := fleettelemetry.New(fleettelemetry.Options{
				ProjectID:          projectID,
				Uplink:             uplinkRegistry,
				Exact:              agents,
				Console:            consoleSource,
				ExactInstanceUUIDs: exactUUIDs,
			})
			if err != nil {
				return err
			}
			policy, err := config.Policy()
			if err != nil {
				return err
			}
			controller, err := fleet.NewController(
				fleet.Platform{ID: "jetstream", DisplayName: "Jetstream", Kind: fleet.PlatformKindOpenStack},
				inventory,
				telemetry,
				policy,
				fleet.ControllerOptions{
					MaxConcurrentAgents: config.MaxConcurrentAgents,
					AgentStaleAfter:     config.AgentStaleAfter,
					AgentTimeout:        config.AgentTimeout,
				},
			)
			if err != nil {
				return err
			}
			var uplinkAuthorizer fleetapi.UplinkAuthorizer
			if config.Uplink.Enabled {
				uplinkAuthorizer, err = fleetapi.NewProjectUplinkAuthorizer(projectID, controller)
				if err != nil {
					return err
				}
			}
			peers, err := fleet.NewStaticPeers(controller, []fleet.Platform{{
				ID: "nidhogg", DisplayName: "Nidhogg", Kind: fleet.PlatformKindHost, DashboardURL: config.NidhoggDashboardURL,
			}})
			if err != nil {
				return err
			}

			controller.Refresh(command.Context())
			go refreshLoop(command.Context(), controller, config.RefreshInterval)

			listener, err := net.Listen("tcp", config.Listen)
			if err != nil {
				return err
			}
			defer listener.Close()
			var handler http.Handler = fleetapi.NewServer(peers, webui.FS(), buildInfo())
			if config.Uplink.Enabled {
				handler, err = fleetapi.NewServerWithUplink(peers, webui.FS(), buildInfo(), fleetapi.UplinkConfig{
					Registry:              uplinkRegistry,
					Authorizer:            uplinkAuthorizer,
					ProjectID:             projectID,
					CreatorTokens:         creatorTokens,
					MaxBodyBytes:          config.Uplink.MaxBodyBytes,
					MaxConcurrentRequests: config.Uplink.MaxConcurrentRequests,
				})
				// The HTTP receiver retains only token digests. Drop the temporary
				// plaintext copies as soon as construction has finished.
				for creatorID := range creatorTokens {
					creatorTokens[creatorID] = ""
				}
				creatorTokens = nil
				if err != nil {
					return err
				}
			}
			server := &http.Server{
				Handler:           handler,
				ReadHeaderTimeout: 5 * time.Second,
				ReadTimeout:       30 * time.Second,
				IdleTimeout:       2 * time.Minute,
				MaxHeaderBytes:    16 << 10,
				BaseContext:       func(net.Listener) context.Context { return command.Context() },
			}
			fmt.Fprintf(app.stderr, "Yggdrasill (MIGLens platform): http://%s/platforms\n", listener.Addr())
			fmt.Fprintln(app.stderr, "OpenStack inventory is project-scoped; telemetry sources are explicitly authorized and source-qualified.")
			if config.Uplink.Enabled {
				fmt.Fprintln(app.stderr, "Authenticated outbound agent uplink is enabled; bearer tokens are loaded only from named environment variables.")
			}
			done := make(chan error, 1)
			go func() { done <- server.Serve(listener) }()
			select {
			case <-command.Context().Done():
				shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				return server.Shutdown(shutdown)
			case err := <-done:
				if errors.Is(err, http.ErrServerClosed) {
					return nil
				}
				return err
			}
		},
	}
}

func loadCreatorTokens(config hubconfig.Config) (map[string]string, error) {
	tokens := make(map[string]string)
	for _, creator := range config.Creators {
		if creator.UplinkTokenEnv == "" {
			continue
		}
		token, found := os.LookupEnv(creator.UplinkTokenEnv)
		if !found {
			return nil, fmt.Errorf("uplink token environment variable %s is not set", creator.UplinkTokenEnv)
		}
		tokens[creator.CreatorID] = token
	}
	if len(tokens) == 0 {
		return nil, errors.New("uplink has no configured creator tokens")
	}
	return tokens, nil
}

func (app *application) loadConfig() (hubconfig.Config, error) {
	config, err := hubconfig.Load(app.configPath)
	if err != nil {
		return hubconfig.Config{}, err
	}
	if os.Getenv("OS_PROJECT_ID") == "" {
		if len(config.OpenStack.AllowedProjectIDs) != 1 {
			return hubconfig.Config{}, errors.New("OS_PROJECT_ID is required when more than one project is allowlisted")
		}
		if err := os.Setenv("OS_PROJECT_ID", config.OpenStack.AllowedProjectIDs[0]); err != nil {
			return hubconfig.Config{}, errors.New("set project-scoped OpenStack environment")
		}
	}
	return config, nil
}

type inventoryManager struct {
	mu     sync.Mutex
	config openstackinventory.Config
	source *openstackinventory.Source
}

func newInventory(ctx context.Context, config hubconfig.Config) (*inventoryManager, error) {
	requestTimeout, err := config.OpenStackRequestTimeout()
	if err != nil {
		return nil, err
	}
	manager := &inventoryManager{config: openstackinventory.Config{
		AllowedProjectIDs:       append([]string(nil), config.OpenStack.AllowedProjectIDs...),
		AllowedAuthHosts:        append([]string(nil), config.OpenStack.AllowedAuthHosts...),
		AllowedComputeHosts:     append([]string(nil), config.OpenStack.AllowedComputeHosts...),
		MaxInstances:            config.OpenStack.MaxInstances,
		RequestTimeout:          requestTimeout,
		AllowConsoleOutput:      config.OpenStack.ConsoleMetricsEnabled,
		MaxConsoleResponseBytes: config.OpenStack.ConsoleMaxResponseBytes,
	}}
	source, err := openstackinventory.NewFromEnv(ctx, manager.config)
	if err != nil {
		return nil, err
	}
	manager.source = source
	return manager, nil
}

// List discards a failed authenticated client. The next bounded refresh builds
// a fresh project-scoped token instead of enabling unbounded SDK reauth.
func (manager *inventoryManager) List(ctx context.Context) (fleet.InventoryObservation, error) {
	source, err := manager.currentSource(ctx)
	if err != nil {
		return fleet.InventoryObservation{}, err
	}
	observation, err := source.List(ctx)
	if err != nil {
		manager.discard(source)
	}
	return observation, err
}

func (manager *inventoryManager) ReadConsole(ctx context.Context, instanceUUID string, lines int) (string, error) {
	source, err := manager.currentSource(ctx)
	if err != nil {
		return "", err
	}
	output, err := source.ReadConsole(ctx, instanceUUID, lines)
	if err != nil {
		manager.discard(source)
	}
	return output, err
}

func (manager *inventoryManager) currentSource(ctx context.Context) (*openstackinventory.Source, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.source != nil {
		return manager.source, nil
	}
	source, err := openstackinventory.NewFromEnv(ctx, manager.config)
	if err != nil {
		return nil, err
	}
	manager.source = source
	return source, nil
}

func (manager *inventoryManager) discard(failed *openstackinventory.Source) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.source == failed {
		manager.source = nil
	}
}

func refreshLoop(ctx context.Context, controller *fleet.Controller, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			controller.Refresh(ctx)
		}
	}
}

func buildInfo() model.BuildInfo {
	return model.BuildInfo{Version: effectiveVersion(), Commit: Commit, BuildDate: BuildDate}
}

func effectiveVersion() string {
	if Version != "dev" {
		return Version
	}
	info, ok := debug.ReadBuildInfo()
	if !ok || info.Main.Version == "" || info.Main.Version == "(devel)" {
		return Version
	}
	return strings.TrimPrefix(info.Main.Version, "v")
}

func versionCommand(stdout io.Writer) *cobra.Command {
	var jsonOutput bool
	command := &cobra.Command{
		Use: "version", Short: "Print version information", Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			info := buildInfo()
			if jsonOutput {
				return json.NewEncoder(stdout).Encode(info)
			}
			_, err := fmt.Fprintf(stdout, "miglens-hub %s (%s, %s)\n", info.Version, info.Commit, info.BuildDate)
			return err
		},
	}
	command.Flags().BoolVar(&jsonOutput, "json", false, "emit JSON")
	return command
}
