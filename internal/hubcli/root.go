// Package hubcli wires the standalone, read-only MIGLens fleet controller.
// It intentionally does not import or start the local GPU collector.
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
	"github.com/intellisys-stevens/miglens/internal/hubconfig"
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
		Short:         "Read-only multi-platform MIGLens controller",
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
		Short: "Serve the read-only fleet dashboard",
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
			agents, err := agentclient.New(config.AgentBindings(), agentclient.Options{Timeout: config.AgentTimeout})
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
				agents,
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
			server := &http.Server{
				Handler:           fleetapi.NewServer(peers, webui.FS(), buildInfo()),
				ReadHeaderTimeout: 5 * time.Second,
				IdleTimeout:       2 * time.Minute,
				BaseContext:       func(net.Listener) context.Context { return command.Context() },
			}
			fmt.Fprintf(app.stderr, "MIGLens fleet dashboard: http://%s/fleet\n", listener.Addr())
			fmt.Fprintln(app.stderr, "OpenStack inventory is read-only; agent probes require exact UUID, Nova creator ID, and HTTPS binding pins.")
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
		AllowedProjectIDs:   append([]string(nil), config.OpenStack.AllowedProjectIDs...),
		AllowedAuthHosts:    append([]string(nil), config.OpenStack.AllowedAuthHosts...),
		AllowedComputeHosts: append([]string(nil), config.OpenStack.AllowedComputeHosts...),
		MaxInstances:        config.OpenStack.MaxInstances,
		RequestTimeout:      requestTimeout,
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
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.source == nil {
		source, err := openstackinventory.NewFromEnv(ctx, manager.config)
		if err != nil {
			return fleet.InventoryObservation{}, err
		}
		manager.source = source
	}
	observation, err := manager.source.List(ctx)
	if err != nil {
		manager.source = nil
	}
	return observation, err
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
