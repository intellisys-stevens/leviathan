package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"runtime/debug"
	"strings"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/api"
	"github.com/intellisys-stevens/leviathan/internal/app"
	"github.com/intellisys-stevens/leviathan/internal/collector"
	"github.com/intellisys-stevens/leviathan/internal/config"
	"github.com/intellisys-stevens/leviathan/internal/doctor"
	"github.com/intellisys-stevens/leviathan/internal/model"
	"github.com/intellisys-stevens/leviathan/internal/openstackmetadata"
	"github.com/intellisys-stevens/leviathan/internal/render"
	"github.com/intellisys-stevens/leviathan/internal/tui"
	"github.com/intellisys-stevens/leviathan/internal/uplinkclient"
	"github.com/intellisys-stevens/leviathan/internal/uplinkstream"
	"github.com/intellisys-stevens/leviathan/internal/webui"
	"github.com/spf13/cobra"
)

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

type application struct {
	stdout io.Writer
	stderr io.Writer
	flags  config.Config
	cfg    config.Config
	path   string
}

func Execute(ctx context.Context, stdout, stderr io.Writer, args []string) error {
	if err := config.RejectLegacyEnv(); err != nil {
		return err
	}
	application := &application{stdout: stdout, stderr: stderr, flags: config.Defaults()}
	root := application.command()
	root.SetArgs(args)
	root.SetOut(stdout)
	root.SetErr(stderr)
	return root.ExecuteContext(ctx)
}

func (a *application) command() *cobra.Command {
	root := &cobra.Command{
		Use:           "leviathan",
		Short:         "MIG-first NVIDIA GPU monitoring",
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(command *cobra.Command, _ []string) error {
			return a.prepareConfig(command)
		},
		RunE: func(command *cobra.Command, _ []string) error { return a.runTUI(command.Context()) },
	}
	flags := root.PersistentFlags()
	flags.StringVar(&a.path, "config", "", "optional XDG TOML configuration file")
	flags.DurationVar(&a.flags.Interval, "interval", a.flags.Interval, "sampling interval (250ms–60s)")
	flags.DurationVar(&a.flags.ProfileInterval, "profile-interval", a.flags.ProfileInterval, "expensive per-entity telemetry interval (250ms–60s)")
	flags.DurationVar(&a.flags.ProcessInterval, "process-interval", a.flags.ProcessInterval, "GPU process inventory interval (250ms–60s)")
	flags.DurationVar(&a.flags.HistoryWindow, "history-window", a.flags.HistoryWindow, "bounded in-memory history window")
	flags.DurationVar(&a.flags.TopologyInterval, "topology-interval", a.flags.TopologyInterval, "MIG topology rescan interval")
	flags.StringVar(&a.flags.Provider, "provider", a.flags.Provider, "provider mode: auto, nvml, dcgm, or fake")
	flags.StringVar(&a.flags.DCGMAddress, "dcgm-address", a.flags.DCGMAddress, "local nv-hostengine address")
	flags.BoolVar(&a.flags.ShowCommandLine, "show-command-line", a.flags.ShowCommandLine, "expose full process command lines")
	flags.BoolVar(&a.flags.NoProfile, "no-profile", a.flags.NoProfile, "disable GPM/DCGM profiling counters")
	flags.StringVar(&a.flags.Listen, "listen", a.flags.Listen, "dashboard listen address (loopback only)")
	flags.BoolVar(&a.flags.NoColor, "no-color", a.flags.NoColor, "disable terminal colors")
	flags.BoolVar(&a.flags.ASCII, "ascii", a.flags.ASCII, "use ASCII terminal glyphs")
	flags.StringVar(&a.flags.Fixture, "fixture", a.flags.Fixture, "use a deterministic fixture (see README for scenarios)")
	flags.StringVar(&a.flags.AttributionSocket, "attribution-socket", a.flags.AttributionSocket, "optional Leviathan attribution bridge Unix socket")

	root.AddCommand(a.tuiCommand(), a.snapshotCommand(), a.watchCommand(), a.serveCommand(), a.uplinkCommand(), a.doctorCommand(), versionCommand(a.stdout))
	return root
}

func (a *application) prepareConfig(command *cobra.Command) error {
	path := config.DefaultPath()
	if value := os.Getenv("LEVIATHAN_CONFIG"); value != "" {
		path = value
	}
	if flagChanged(command, "config") {
		path = a.path
	}
	cfg := config.Defaults()
	if err := config.LoadFile(path, &cfg); err != nil {
		return err
	}
	if err := config.ApplyEnv(&cfg); err != nil {
		return err
	}
	a.applyFlags(command, &cfg)
	if err := config.Validate(cfg); err != nil {
		return err
	}
	a.cfg = cfg
	return nil
}

func (a *application) applyFlags(command *cobra.Command, cfg *config.Config) {
	if flagChanged(command, "interval") {
		cfg.Interval = a.flags.Interval
	}
	if flagChanged(command, "profile-interval") {
		cfg.ProfileInterval = a.flags.ProfileInterval
	}
	if flagChanged(command, "process-interval") {
		cfg.ProcessInterval = a.flags.ProcessInterval
	}
	if flagChanged(command, "history-window") {
		cfg.HistoryWindow = a.flags.HistoryWindow
	}
	if flagChanged(command, "topology-interval") {
		cfg.TopologyInterval = a.flags.TopologyInterval
	}
	if flagChanged(command, "provider") {
		cfg.Provider = a.flags.Provider
	}
	if flagChanged(command, "dcgm-address") {
		cfg.DCGMAddress = a.flags.DCGMAddress
	}
	if flagChanged(command, "show-command-line") {
		cfg.ShowCommandLine = a.flags.ShowCommandLine
	}
	if flagChanged(command, "no-profile") {
		cfg.NoProfile = a.flags.NoProfile
	}
	if flagChanged(command, "listen") {
		cfg.Listen = a.flags.Listen
	}
	if flagChanged(command, "no-color") {
		cfg.NoColor = a.flags.NoColor
	}
	if flagChanged(command, "ascii") {
		cfg.ASCII = a.flags.ASCII
	}
	if flagChanged(command, "fixture") {
		cfg.Fixture = a.flags.Fixture
	}
	if flagChanged(command, "attribution-socket") {
		cfg.AttributionSocket = a.flags.AttributionSocket
	}
}

func flagChanged(command *cobra.Command, name string) bool {
	if flag := command.Flags().Lookup(name); flag != nil && flag.Changed {
		return true
	}
	if flag := command.InheritedFlags().Lookup(name); flag != nil && flag.Changed {
		return true
	}
	return false
}

func (a *application) tuiCommand() *cobra.Command {
	return &cobra.Command{Use: "tui", Short: "Open the interactive terminal monitor", RunE: func(command *cobra.Command, _ []string) error { return a.runTUI(command.Context()) }}
}

func (a *application) runTUI(ctx context.Context) error {
	engine, err := a.startEngine(ctx)
	if err != nil {
		return err
	}
	defer engine.Stop()
	return tui.Run(ctx, engine, a.cfg)
}

func (a *application) snapshotCommand() *cobra.Command {
	format := "table"
	command := &cobra.Command{
		Use: "snapshot", Short: "Print one canonical snapshot", Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if format != "table" && format != "json" {
				return fmt.Errorf("format must be table or json")
			}
			snapshot, err := a.sample(command.Context())
			if err != nil {
				return err
			}
			if format == "json" {
				encoder := json.NewEncoder(a.stdout)
				encoder.SetIndent("", "  ")
				return encoder.Encode(snapshot)
			}
			render.SnapshotTable(a.stdout, snapshot, a.cfg.ASCII)
			return nil
		},
	}
	command.Flags().StringVarP(&format, "format", "f", format, "output format: table or json")
	return command
}

func (a *application) sample(ctx context.Context) (model.Snapshot, error) {
	source, err := app.Provider(a.cfg)
	if err != nil {
		return model.Snapshot{}, err
	}
	if err := source.Open(ctx); err != nil {
		return model.Snapshot{}, err
	}
	defer source.Close()
	snapshot, err := source.Sample(ctx, time.Now().UTC())
	if err != nil {
		return snapshot, err
	}
	if snapshot.Capabilities.GPM.Available && !a.cfg.NoProfile {
		timer := time.NewTimer(maxDuration(a.cfg.ProfileInterval, maxDuration(a.cfg.Interval, 250*time.Millisecond)))
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return model.Snapshot{}, ctx.Err()
		case <-timer.C:
		}
		snapshot, err = source.Sample(ctx, time.Now().UTC())
	}
	snapshot.Sequence = 1
	return snapshot, err
}

func (a *application) watchCommand() *cobra.Command {
	format := "table"
	command := &cobra.Command{
		Use: "watch", Short: "Continuously emit canonical snapshots", Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if format != "table" && format != "jsonl" {
				return fmt.Errorf("format must be table or jsonl")
			}
			engine, err := a.startEngine(command.Context())
			if err != nil {
				return err
			}
			defer engine.Stop()
			events, unsubscribe := engine.Subscribe()
			defer unsubscribe()
			encoder := json.NewEncoder(a.stdout)
			for {
				select {
				case <-command.Context().Done():
					return nil
				case snapshot, ok := <-events:
					if !ok {
						return nil
					}
					if format == "jsonl" {
						if err := encoder.Encode(snapshot); err != nil {
							return err
						}
					} else {
						render.SnapshotTable(a.stdout, snapshot, a.cfg.ASCII)
						fmt.Fprintln(a.stdout)
					}
				}
			}
		},
	}
	command.Flags().StringVarP(&format, "format", "f", format, "output format: table or jsonl")
	return command
}

func (a *application) serveCommand() *cobra.Command {
	return &cobra.Command{
		Use: "serve", Short: "Serve the embedded local dashboard", Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := config.ValidateLoopback(a.cfg.Listen); err != nil {
				return err
			}
			engine, err := a.startEngine(command.Context())
			if err != nil {
				return err
			}
			defer engine.Stop()
			listener, err := net.Listen("tcp", a.cfg.Listen)
			if err != nil {
				return err
			}
			defer listener.Close()
			server := &http.Server{
				Handler:           api.NewServer(engine, webui.FS(), buildInfo()),
				ReadHeaderTimeout: 5 * time.Second,
				IdleTimeout:       2 * time.Minute,
				// SSE connections are intentionally long-lived. Tie their base context
				// to the command so an interrupt can drain Shutdown immediately.
				BaseContext: func(net.Listener) context.Context { return command.Context() },
			}
			fmt.Fprintf(a.stderr, "Leviathan dashboard: http://%s\n", listener.Addr())
			fmt.Fprintln(a.stderr, tunnelHint(listener.Addr()))
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

var uplinkEnvironmentName = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)
var uplinkInstanceUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func (a *application) uplinkCommand() *cobra.Command {
	var hubURL string
	var instanceUUID string
	var tokenEnvironment string
	var pushInterval time.Duration
	command := &cobra.Command{
		Use:   "uplink",
		Short: "Continuously push local telemetry to an authenticated Leviathan Hub",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if pushInterval < 500*time.Millisecond || pushInterval > 5*time.Minute {
				return errors.New("uplink interval must be between 500ms and 5m")
			}
			if !uplinkEnvironmentName.MatchString(tokenEnvironment) {
				return errors.New("uplink token environment variable name is invalid")
			}
			if instanceUUID != "" && !uplinkInstanceUUID.MatchString(instanceUUID) {
				return errors.New("uplink instance UUID must be a canonical lowercase UUID")
			}
			token, found := os.LookupEnv(tokenEnvironment)
			if !found {
				return fmt.Errorf("uplink token environment variable %s is not set", tokenEnvironment)
			}
			client, err := uplinkclient.New(hubURL, token, uplinkclient.Options{})
			if err != nil {
				return err
			}
			if instanceUUID == "" {
				metadata, metadataErr := openstackmetadata.New(openstackmetadata.Options{})
				if metadataErr != nil {
					return metadataErr
				}
				instanceUUID, metadataErr = metadata.InstanceUUID(command.Context())
				if metadataErr != nil {
					return metadataErr
				}
			}

			engine, err := a.startEngine(command.Context())
			if err != nil {
				return err
			}
			defer engine.Stop()

			info := buildInfo()
			updates, unsubscribe := engine.Subscribe()
			defer unsubscribe()
			return uplinkstream.Run(command.Context(), updates, pushInterval, func(ctx context.Context, snapshot model.Snapshot) error {
				return client.Send(ctx, instanceUUID, snapshot, &info)
			}, a.stderr)
		},
	}
	command.Flags().StringVar(&hubURL, "hub-url", "", "required credential-free HTTPS Leviathan Hub origin")
	command.Flags().StringVar(&instanceUUID, "instance-uuid", "", "OpenStack instance UUID (default: discover from link-local metadata)")
	command.Flags().StringVar(&tokenEnvironment, "token-env", "LEVIATHAN_UPLINK_TOKEN", "environment variable containing the creator-scoped bearer token")
	command.Flags().DurationVar(&pushInterval, "uplink-interval", 500*time.Millisecond, "telemetry push interval (500ms–5m)")
	_ = command.MarkFlagRequired("hub-url")
	return command
}

func tunnelHint(address net.Addr) string {
	_, port, err := net.SplitHostPort(address.String())
	if err != nil {
		return "Remote access: forward the dashboard's loopback port over SSH"
	}
	return fmt.Sprintf("Remote access: ssh -L %s:127.0.0.1:%s <host>", port, port)
}

func buildInfo() model.BuildInfo {
	return model.BuildInfo{
		Version:   effectiveVersion(),
		Commit:    Commit,
		BuildDate: BuildDate,
	}
}

func effectiveVersion() string {
	if Version != "dev" {
		return Version
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return Version
	}
	return resolveVersion(Version, info.Main.Version)
}

func resolveVersion(linkerVersion, moduleVersion string) string {
	if linkerVersion != "dev" || moduleVersion == "" || moduleVersion == "(devel)" {
		return linkerVersion
	}
	return strings.TrimPrefix(moduleVersion, "v")
}

func (a *application) doctorCommand() *cobra.Command {
	format := "text"
	command := &cobra.Command{
		Use: "doctor", Short: "Diagnose providers, namespaces, sockets, and permissions", Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if format != "text" && format != "json" {
				return fmt.Errorf("format must be text or json")
			}
			report := doctor.Run(command.Context(), a.cfg)
			if format == "json" {
				encoder := json.NewEncoder(a.stdout)
				encoder.SetIndent("", "  ")
				return encoder.Encode(report)
			}
			render.DoctorText(a.stdout, report)
			return nil
		},
	}
	command.Flags().StringVarP(&format, "format", "f", format, "output format: text or json")
	return command
}

func versionCommand(stdout io.Writer) *cobra.Command {
	format := "text"
	command := &cobra.Command{
		Use: "version", Short: "Print build version", Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			version := effectiveVersion()
			if format == "json" {
				return json.NewEncoder(stdout).Encode(map[string]string{"version": version, "commit": Commit, "buildDate": BuildDate})
			}
			if format != "text" {
				return fmt.Errorf("format must be text or json")
			}
			_, err := fmt.Fprintf(stdout, "leviathan %s (%s, %s)\n", version, Commit, BuildDate)
			return err
		},
	}
	command.Flags().StringVarP(&format, "format", "f", format, "output format: text or json")
	command.PersistentPreRunE = func(_ *cobra.Command, _ []string) error { return nil }
	return command
}

func (a *application) startEngine(ctx context.Context) (*collector.Engine, error) {
	source, err := app.Provider(a.cfg)
	if err != nil {
		return nil, err
	}
	engine := collector.NewWithOptions(source, collector.Options{
		SamplingInterval: a.cfg.Interval,
		HistoryWindow:    a.cfg.HistoryWindow,
		ProfileInterval:  maxDuration(a.cfg.ProfileInterval, a.cfg.Interval),
		ProcessInterval:  maxDuration(a.cfg.ProcessInterval, a.cfg.Interval),
	})
	if err := engine.Start(ctx); err != nil {
		return nil, err
	}
	return engine, nil
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}
