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
	"runtime/debug"
	"strings"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/api"
	"github.com/intellisys-stevens/leviathan/internal/app"
	"github.com/intellisys-stevens/leviathan/internal/collector"
	"github.com/intellisys-stevens/leviathan/internal/config"
	"github.com/intellisys-stevens/leviathan/internal/doctor"
	"github.com/intellisys-stevens/leviathan/internal/health"
	"github.com/intellisys-stevens/leviathan/internal/render"
	"github.com/intellisys-stevens/leviathan/internal/tui"
	"github.com/intellisys-stevens/leviathan/internal/uplink"
	"github.com/intellisys-stevens/leviathan/internal/webui"
	"github.com/intellisys-stevens/leviathan/model"
	"github.com/spf13/cobra"
)

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

type application struct {
	errorFormat string
	errorCode   string
	stdout      io.Writer
	stderr      io.Writer
	flags       config.Config
	cfg         config.Config
	path        string
}

func Execute(ctx context.Context, stdout, stderr io.Writer, args []string) error {
	application := &application{stdout: stdout, stderr: stderr, flags: config.Defaults(), errorFormat: "text", errorCode: "command_failed"}
	root := application.command()
	root.SetArgs(args)
	root.SetOut(stdout)
	root.SetErr(stderr)
	err := root.ExecuteContext(ctx)
	return commandError(err, application.errorCode, application.errorFormat == "json")
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
	flags.StringVar(&a.errorFormat, "error-format", "text", "stderr error format: text or json")
	flags.StringVar(&a.path, "config", "", "optional XDG TOML configuration file")
	flags.DurationVar(&a.flags.Interval, "interval", a.flags.Interval, "sampling interval (250ms–60s)")
	flags.DurationVar(&a.flags.ProfileInterval, "profile-interval", a.flags.ProfileInterval, "expensive per-entity telemetry interval (250ms–60s)")
	flags.DurationVar(&a.flags.ProcessInterval, "process-interval", a.flags.ProcessInterval, "GPU process inventory interval (250ms–60s)")
	flags.DurationVar(&a.flags.HistoryWindow, "history-window", a.flags.HistoryWindow, "bounded in-memory history window (last hour raw, older data compact)")
	flags.DurationVar(&a.flags.TopologyInterval, "topology-interval", a.flags.TopologyInterval, "MIG topology rescan interval")
	flags.StringVar(&a.flags.Provider, "provider", a.flags.Provider, "provider mode: auto, nvml, dcgm, or fake")
	flags.StringVar(&a.flags.DCGMAddress, "dcgm-address", a.flags.DCGMAddress, "local nv-hostengine address")
	flags.BoolVar(&a.flags.ShowCommandLine, "show-command-line", a.flags.ShowCommandLine, "expose full process command lines")
	flags.BoolVar(&a.flags.NoProfile, "no-profile", a.flags.NoProfile, "disable GPM/DCGM profiling counters")
	flags.StringVar(&a.flags.Listen, "listen", a.flags.Listen, "dashboard listen address (loopback only)")
	flags.BoolVar(&a.flags.NoColor, "no-color", a.flags.NoColor, "disable terminal colors")
	flags.BoolVar(&a.flags.ASCII, "ascii", a.flags.ASCII, "use ASCII terminal glyphs")
	flags.StringVar(&a.flags.Fixture, "fixture", a.flags.Fixture, "use a deterministic fixture (see README for scenarios)")
	flags.StringVar(&a.flags.AttributionCheckpointPath, "attribution-checkpoint-path", a.flags.AttributionCheckpointPath, "optional read-only NVIDIA DRA v0.4.1 checkpoint")
	flags.StringVar(&a.flags.AttributionSocket, "attribution-socket", a.flags.AttributionSocket, "optional Leviathan attribution bridge Unix socket")
	flags.BoolVar(&a.flags.WorkloadTelemetry, "workload-telemetry", a.flags.WorkloadTelemetry, "collect Coder owner cgroup telemetry using the private workload inventory")
	flags.BoolVar(&a.flags.Health.Enabled, "health-history", a.flags.Health.Enabled, "save 30 days of local health observations during serve")
	flags.StringVar(&a.flags.Health.Directory, "health-dir", a.flags.Health.Directory, "private local health history directory")

	root.AddCommand(a.tuiCommand(), a.snapshotCommand(), a.watchCommand(), a.serveCommand(), a.doctorCommand(), a.configCheckCommand(), a.pluginsCommand(), a.joinCommand(), versionCommand(a.stdout))
	return root
}

func (a *application) prepareConfig(command *cobra.Command) error {
	a.errorCode = "invalid_config"
	if a.errorFormat != "text" && a.errorFormat != "json" {
		return errors.New("error-format must be text or json")
	}
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
	a.errorCode = "command_failed"
	if command.Parent() != nil && command.Parent().Name() == "plugins" {
		a.errorCode = "plugin_check_failed"
	}
	return nil
}

func (a *application) applyFlags(command *cobra.Command, cfg *config.Config) {
	if flagChanged(command, "health-history") {
		cfg.Health.Enabled = a.flags.Health.Enabled
	}
	if flagChanged(command, "health-dir") {
		cfg.Health.Directory = a.flags.Health.Directory
	}
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
	if flagChanged(command, "workload-telemetry") {
		cfg.WorkloadTelemetry = a.flags.WorkloadTelemetry
	}
	if flagChanged(command, "attribution-checkpoint-path") {
		cfg.AttributionCheckpointPath = a.flags.AttributionCheckpointPath
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
				return encoder.Encode(model.NormalizeSnapshot(snapshot))
			}
			render.SnapshotTable(a.stdout, snapshot, a.cfg.ASCII)
			return nil
		},
	}
	command.Flags().StringVarP(&format, "format", "f", format, "output format: table or json")
	return command
}

func (a *application) sample(ctx context.Context) (model.Snapshot, error) {
	engine, sources, err := app.NewEngine(a.cfg)
	if err != nil {
		return model.Snapshot{}, err
	}
	warmup := min(max(a.cfg.Interval, 250*time.Millisecond), time.Second)
	if !a.cfg.NoProfile {
		warmup = max(warmup, a.cfg.ProfileInterval)
	}
	if err := sources.Collect(ctx, warmup, engine.AcceptObservation); err != nil {
		if _, ok := engine.Current(); !ok {
			return model.Snapshot{}, err
		}
	}
	if ctx.Err() != nil {
		return model.Snapshot{}, ctx.Err()
	}
	snapshot, ok := engine.Current()
	if !ok {
		return model.Snapshot{}, errors.New("no plugin observations available")
	}
	return snapshot, nil
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
						if err := encoder.Encode(model.NormalizeSnapshot(snapshot)); err != nil {
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
			serveContext, cancelServe := context.WithCancel(command.Context())
			engine, err := a.startEngine(serveContext)
			if err != nil {
				cancelServe()
				return err
			}
			defer func() {
				cancelServe()
				_ = engine.Stop()
			}()
			uplinkTracker := health.NewUplinkTracker(health.UplinkOptions{Enabled: a.cfg.Uplink.Enabled, Interval: a.cfg.Uplink.Interval})
			reportAttempt := uplinkAttemptReporter(a.stderr)
			uplinkRunner, err := newConfiguredUplink(a.cfg.Uplink, engine, buildInfo(), func(result uplink.AttemptResult) {
				uplinkTracker.Observe(result)
				reportAttempt(result)
			})
			if err != nil {
				return err
			}
			var uplinkDone <-chan error
			if uplinkRunner != nil {
				done := make(chan error, 1)
				uplinkDone = done
				go func() { done <- uplinkRunner.Run(serveContext) }()
				fmt.Fprintln(a.stderr, "Yggdrasil uplink enabled")
			}
			listener, err := net.Listen("tcp", a.cfg.Listen)
			if err != nil {
				return err
			}
			defer listener.Close()
			healthRecorder := health.New(engine, health.Options{
				Enabled:   a.cfg.Health.Enabled && a.cfg.Provider != "fake" && a.cfg.Fixture == "",
				Directory: a.cfg.Health.Directory, Attribution: a.cfg.AttributionSocket != "", Uplink: uplinkTracker,
			})
			healthContext, cancelHealth := context.WithCancel(serveContext)
			healthDone := make(chan struct{})
			go func() { defer close(healthDone); healthRecorder.Run(healthContext) }()
			defer func() {
				cancelHealth()
				<-healthDone
				if err := healthRecorder.Close(); err != nil {
					fmt.Fprintln(a.stderr, "Health history flush:", err)
				}
			}()
			handler := api.NewServer(engine, webui.FS(), buildInfo(), healthRecorder)
			handler.WithGPUCapacity(engine)
			server := &http.Server{
				Handler:           handler,
				ReadHeaderTimeout: 5 * time.Second,
				IdleTimeout:       2 * time.Minute,
				// SSE connections are intentionally long-lived. Tie their base context
				// to the command so an interrupt can drain Shutdown immediately.
				BaseContext: func(net.Listener) context.Context { return serveContext },
			}
			fmt.Fprintf(a.stderr, "Leviathan dashboard: http://%s\n", listener.Addr())
			fmt.Fprintln(a.stderr, tunnelHint(listener.Addr()))
			done := make(chan error, 1)
			go func() { done <- server.Serve(listener) }()
			select {
			case <-serveContext.Done():
				shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				return server.Shutdown(shutdown)
			case err := <-uplinkDone:
				if serveContext.Err() != nil {
					shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					return server.Shutdown(shutdown)
				}
				cancelServe()
				shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = server.Shutdown(shutdown)
				if err == nil {
					err = uplink.ErrSnapshotSourceEnd
				}
				return fmt.Errorf("uplink stopped: %w", err)
			case err := <-done:
				if errors.Is(err, http.ErrServerClosed) {
					return nil
				}
				return err
			}
		},
	}
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
	requireGPU := false
	command := &cobra.Command{
		Use: "doctor", Short: "Diagnose providers, namespaces, sockets, and permissions", Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if format != "text" && format != "json" {
				return fmt.Errorf("format must be text or json")
			}
			report := doctor.Run(command.Context(), a.cfg, doctor.Options{RequireGPU: requireGPU})
			if format == "json" {
				encoder := json.NewEncoder(a.stdout)
				encoder.SetIndent("", "  ")
				if err := encoder.Encode(report); err != nil {
					return err
				}
			} else {
				render.DoctorText(a.stdout, report.CheckedAt, report.Status, report.Diagnostics)
			}
			if requireGPU && !report.GPUAvailable {
				return errors.New("an NVIDIA GPU is required but unavailable")
			}
			return nil
		},
	}
	command.Flags().StringVarP(&format, "format", "f", format, "output format: text or json")
	command.Flags().BoolVar(&requireGPU, "require-gpu", false, "fail when no usable NVIDIA GPU is detected")
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
	engine, _, err := app.NewEngine(a.cfg)
	if err != nil {
		return nil, err
	}
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
