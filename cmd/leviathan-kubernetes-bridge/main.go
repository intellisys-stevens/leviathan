package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/go-logr/logr"
	"github.com/intellisys-stevens/leviathan/internal/kubernetesbridge"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/metadata"
	"k8s.io/client-go/rest"
	"k8s.io/klog/v2"
)

var BridgeVersion = "dev"

func main() {
	// Client-go error paths can contain object names or API endpoints. The
	// bridge emits its own count-only health logs instead.
	klog.SetOutput(io.Discard)
	klog.SetLogger(logr.Discard())
	if err := execute(os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "leviathan-kubernetes-bridge: operation failed")
		os.Exit(1)
	}
}

func execute(arguments []string) error {
	if len(arguments) > 0 && arguments[0] == "probe" {
		return runProbe(arguments[1:])
	}
	flags := flag.NewFlagSet("leviathan-kubernetes-bridge", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	socketPath := flags.String("socket", "/run/leviathan/attribution.sock", "Unix socket handoff path")
	nodeName := flags.String("node-name", os.Getenv("NODE_NAME"), "Kubernetes node name")
	namespaceList := flags.String("namespaces", os.Getenv("WATCH_NAMESPACES"), "comma-separated Coder workspace namespaces")
	driver := flags.String("driver", "gpu.nvidia.com", "DRA driver name")
	workloadInventory := flags.Bool("workload-inventory", false, "enable metadata-only Coder Pod inventory")
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 {
		return errors.New("invalid bridge arguments")
	}
	namespaces := splitNamespaces(*namespaceList)
	if strings.TrimSpace(*socketPath) == "" || strings.TrimSpace(*nodeName) == "" || len(namespaces) == 0 {
		return errors.New("missing bridge configuration")
	}

	config, err := rest.InClusterConfig()
	if err != nil {
		return errors.New("Kubernetes in-cluster configuration is unavailable")
	}
	config.UserAgent = "leviathan-kubernetes-bridge/" + BridgeVersion
	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		return errors.New("Kubernetes client initialization failed")
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	state := kubernetesbridge.NewState(BridgeVersion, *nodeName, time.Now().UTC())
	options := kubernetesbridge.DefaultControllerOptions(*nodeName, namespaces)
	options.Driver = *driver
	options.Logger = logger
	controller, err := kubernetesbridge.NewController(client, state, options)
	if err != nil {
		return errors.New("invalid Kubernetes attribution configuration")
	}
	server := kubernetesbridge.NewServer(state)
	var workloadController *kubernetesbridge.WorkloadController
	if *workloadInventory {
		metadataClient, metadataErr := metadata.NewForConfig(kubernetesbridge.MetadataOnlyConfig(config))
		if metadataErr != nil {
			return errors.New("Kubernetes metadata client initialization failed")
		}
		workloadState := kubernetesbridge.NewWorkloadState(time.Now().UTC())
		workloadController, err = kubernetesbridge.NewWorkloadController(metadataClient, workloadState, options)
		if err != nil {
			return err
		}
		server.WithWorkloads(workloadState)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	workers := 2
	if workloadController != nil {
		workers++
	}
	results := make(chan error, workers)
	go func() {
		// DRA failures must not terminate the independent metadata inventory.
		for {
			attempt, cancelAttempt := context.WithCancel(ctx)
			err := controller.Run(attempt)
			cancelAttempt()
			if ctx.Err() != nil {
				results <- nil
				return
			}
			if err == nil {
				results <- nil
				return
			}
			state.MarkUnavailable()
			timer := time.NewTimer(5 * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				results <- nil
				return
			case <-timer.C:
			}
		}
	}()
	if workloadController != nil {
		go func() { results <- workloadController.Run(ctx) }()
	}
	go func() {
		results <- kubernetesbridge.ServeUnix(ctx, *socketPath, server.Handler())
	}()
	first := <-results
	cancel()
	for i := 1; i < workers; i++ {
		first = errors.Join(first, <-results)
	}
	if first != nil {
		return errors.New("bridge runtime stopped unexpectedly")
	}
	return nil
}

func splitNamespaces(value string) []string {
	seen := map[string]struct{}{}
	result := []string{}
	for _, namespace := range strings.Split(value, ",") {
		namespace = strings.TrimSpace(namespace)
		if namespace == "" {
			continue
		}
		if _, exists := seen[namespace]; !exists {
			seen[namespace] = struct{}{}
			result = append(result, namespace)
		}
	}
	sort.Strings(result)
	return result
}

func runProbe(arguments []string) error {
	flags := flag.NewFlagSet("probe", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	socketPath := flags.String("socket", "/run/leviathan/attribution.sock", "Unix socket path")
	ready := flags.Bool("ready", false, "require synchronized Kubernetes caches")
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 {
		return errors.New("invalid probe arguments")
	}
	path := "/livez"
	if *ready {
		path = "/readyz"
	}
	dialer := &net.Dialer{Timeout: time.Second}
	client := &http.Client{
		Timeout: time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", *socketPath)
		}},
	}
	request, err := http.NewRequest(http.MethodGet, "http://unix"+path, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	if response.StatusCode != http.StatusOK {
		return errors.New("bridge probe is not healthy")
	}
	return nil
}
