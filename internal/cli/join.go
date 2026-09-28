package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/config"
	"github.com/intellisys-stevens/leviathan/internal/uplink"
	"github.com/pelletier/go-toml/v2"
	"github.com/spf13/cobra"
)

func (a *application) joinCommand() *cobra.Command {
	var server, directory string
	var tokenStdin bool
	command := &cobra.Command{Use: "join", Short: "Connect this installed agent to Yggdrasil", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		if !tokenStdin {
			return errors.New("provide the one-time join ticket on standard input with --token-stdin")
		}
		body, err := io.ReadAll(io.LimitReader(command.InOrStdin(), 4097))
		if err != nil || len(body) > 4096 {
			return errors.New("cannot read join ticket")
		}
		ticket := strings.TrimSpace(string(body))
		if ticket == "" {
			return errors.New("join ticket is empty")
		}
		path := config.DefaultPath()
		if value := os.Getenv("LEVIATHAN_CONFIG"); value != "" {
			path = value
		}
		if flagChanged(command, "config") {
			path = a.path
		}
		path, err = filepath.Abs(path)
		if err != nil {
			return err
		}
		directory, err = filepath.Abs(directory)
		if err != nil {
			return err
		}
		statePath := filepath.Join(directory, "state.json")
		client, err := uplink.NewEnrollmentClient(server, nil)
		if err != nil {
			return err
		}
		hostname, err := os.Hostname()
		if err != nil {
			return err
		}
		receipt, err := client.Join(command.Context(), statePath, uplink.JoinRequest{Ticket: ticket, Hostname: hostname, OS: runtime.GOOS, Arch: runtime.GOARCH, AgentVersion: Version})
		if err != nil {
			return err
		}
		if err = writeJoinConfig(path, server, statePath); err != nil {
			return fmt.Errorf("machine registered; writing agent config failed: %w", err)
		}
		started, err := configureJoinedService(command.Context(), path, directory, server)
		if err != nil {
			return fmt.Errorf("machine registered and config saved; service setup failed: %w", err)
		}
		fmt.Fprintf(a.stdout, "Registered %s/%s/%s. Credentials renew automatically.\n", receipt.Machine.PlatformID, receipt.Machine.ScopeID, receipt.Machine.MachineID)
		if started {
			fmt.Fprintln(a.stdout, "Leviathan service restarted; Yggdrasil will show connected after its first accepted upload.")
		} else {
			fmt.Fprintf(a.stdout, "Configuration saved to %s. Start Leviathan serve with this configuration; Yggdrasil confirms the first accepted upload.\n", path)
		}
		return nil
	}}
	command.Flags().StringVar(&server, "server", "", "Yggdrasil HTTPS origin")
	command.Flags().StringVar(&directory, "state-dir", "/var/lib/leviathan/enrollment", "private enrollment state directory")
	command.Flags().BoolVar(&tokenStdin, "token-stdin", false, "read the one-time join ticket from standard input")
	_ = command.MarkFlagRequired("server")
	return command
}

func writeJoinConfig(path, server, statePath string) error {
	values := map[string]any{}
	mode := os.FileMode(0600)
	body, err := os.ReadFile(path)
	if err == nil {
		if err = toml.Unmarshal(body, &values); err != nil {
			return err
		}
		info, e := os.Stat(path)
		if e != nil {
			return e
		}
		mode = info.Mode().Perm()
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	settings, ok := values["uplink"].(map[string]any)
	if !ok {
		settings = map[string]any{}
	}
	settings["enabled"], settings["base_url"], settings["state_file"], settings["schema"] = true, server, statePath, uplink.SchemaV2
	delete(settings, "token_file")
	if _, exists := settings["interval"]; !exists {
		settings["interval"] = "15s"
	}
	values["uplink"] = settings
	if _, exists := values["listen"]; !exists {
		values["listen"] = config.DefaultListen
	}
	body, err = toml.Marshal(values)
	if err != nil {
		return err
	}
	return uplink.AtomicWriteFile(path, body, mode)
}

// Joining changes only the matching existing root monitor service. It does
// not replace service files or adopt an unrelated installation.
func configureJoinedService(ctx context.Context, configPath, stateDirectory, server string) (bool, error) {
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		return false, nil
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return false, nil
	}
	const unit = "leviathan@root.service"
	output, err := exec.CommandContext(ctx, "systemctl", "show", unit, "--property=FragmentPath,ExecStart,User").Output()
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	if err != nil || !strings.Contains(string(output), "FragmentPath=/") {
		return false, nil
	}
	addresses, err := joinedServiceAddresses(ctx, server)
	if err != nil {
		return false, err
	}
	body, err := joinedServiceDropIn(string(output), configPath, stateDirectory, addresses)
	if err != nil {
		return false, err
	}
	path := "/etc/systemd/system/" + unit + ".d/30-enrollment.conf"
	if err = uplink.AtomicWriteFile(path, []byte(body), 0644); err != nil {
		return false, err
	}
	for _, args := range [][]string{{"daemon-reload"}, {"restart", unit}} {
		if err = exec.CommandContext(ctx, "systemctl", args...).Run(); err != nil {
			if ctx.Err() != nil {
				return false, ctx.Err()
			}
			return false, err
		}
	}
	return true, nil
}

// The stock monitor predates configuration-based uplink. Adopt its exact known
// command; a configured service keeps every argument supplied by its owner.
func joinedServiceDropIn(properties, configPath, stateDirectory string, addresses []string) (string, error) {
	if strings.ContainsAny(stateDirectory, "\n\r%\"\\") || strings.ContainsAny(configPath, "\n\r%\"\\") {
		return "", errors.New("systemd path contains unsupported characters")
	}
	for _, line := range strings.Split(properties, "\n") {
		if user, ok := strings.CutPrefix(line, "User="); ok && user != "" && user != "root" && user != "0" {
			return "", errors.New("existing root service runs as another user; configure its credential access explicitly")
		}
	}
	_, executablePath, foundPath := strings.Cut(properties, "path=")
	executablePath, _, pathTerminated := strings.Cut(executablePath, " ;")
	_, arguments, found := strings.Cut(properties, "argv[]=")
	arguments, _, terminated := strings.Cut(arguments, " ;")
	executable, _, separated := strings.Cut(arguments, " ")
	if !foundPath || !pathTerminated || executablePath != "/usr/local/bin/leviathan" || !found || !terminated || !separated || strings.Count(properties, "argv[]=") != 1 || executable != "/usr/local/bin/leviathan" || !strings.Contains(" "+arguments+" ", " serve ") {
		return "", errors.New("existing root service does not run the matching Leviathan monitor directly")
	}
	command := ""
	stock := "argv[]=/usr/local/bin/leviathan --listen 127.0.0.1:1397 serve ;"
	adopted := "argv[]=/usr/local/bin/leviathan --config " + configPath + " --listen 127.0.0.1:1397 serve ;"
	if strings.Contains(properties, stock) || strings.Contains(properties, adopted) {
		command = fmt.Sprintf("ExecStart=\nExecStart=/usr/local/bin/leviathan --config \"%s\" --listen 127.0.0.1:1397 serve\n", configPath)
	} else {
		configurations := []string{}
		fields := strings.Fields(arguments)
		for index, field := range fields {
			if field == "--config" && index+1 < len(fields) {
				configurations = append(configurations, fields[index+1])
			} else if value, found := strings.CutPrefix(field, "--config="); found {
				configurations = append(configurations, value)
			}
		}
		if len(configurations) != 1 || configurations[0] != configPath {
			return "", errors.New("existing root service uses another configuration; restart its matching installation explicitly")
		}
	}
	for _, address := range addresses {
		if net.ParseIP(address) == nil {
			return "", errors.New("systemd network exception must be an IP address")
		}
	}
	if len(addresses) == 0 {
		return "", errors.New("no network addresses resolved for enrollment")
	}
	return fmt.Sprintf("[Unit]\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\n%s# Preserve existing network restrictions; permit the resolved uplink/proxy and DNS endpoints.\nIPAddressAllow=%s\nReadWritePaths=\"%s\"\n", command, strings.Join(addresses, " "), stateDirectory), nil
}

// systemd IP filters accept addresses, not DNS names. Resolve the selected
// HTTPS origin and configured proxy, plus the host's DNS servers, without
// clearing any operator-supplied ingress or egress restrictions.
func joinedServiceAddresses(ctx context.Context, server string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server, nil)
	if err != nil {
		return nil, err
	}
	hosts := []string{request.URL.Hostname()}
	proxy, err := http.ProxyFromEnvironment(request)
	if err != nil {
		return nil, err
	}
	if proxy != nil {
		hosts = append(hosts, proxy.Hostname())
	}
	addresses := map[string]bool{}
	for _, host := range hosts {
		resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, fmt.Errorf("resolve enrollment network endpoint: %w", err)
		}
		for _, address := range resolved {
			addresses[address.IP.String()] = true
		}
	}
	resolvers, err := os.Open("/etc/resolv.conf")
	if err != nil {
		return nil, err
	}
	defer resolvers.Close()
	scanner := bufio.NewScanner(resolvers)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 && fields[0] == "nameserver" {
			if ip := net.ParseIP(fields[1]); ip != nil {
				addresses[ip.String()] = true
			}
		}
	}
	if err = scanner.Err(); err != nil {
		return nil, err
	}
	result := make([]string, 0, len(addresses))
	for address := range addresses {
		result = append(result, address)
	}
	sort.Strings(result)
	return result, nil
}
