//go:build linux

package updater

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

// Explicitly opt-in continuation on one identity-checked disposable VM. The
// helpers NEVER issue reboot: the operator verifies the host/workloads and
// reboots separately. No production endpoint or release key is used.
const rebootAcceptanceDir = "/var/lib/leviathan-merge-acceptance"
const rebootControlUnit = "leviathan-acceptance-control.service"

type rebootFixtureConfig struct {
	HostUUID       string `json:"hostUuid"`
	InitialBootID  string `json:"initialBootId"`
	Address        string `json:"address"`
	Config         Config `json:"config"`
	RequiredSystem bool   `json:"requiredSystem"`
	RequiredGPU    bool   `json:"requiredGPU"`
}

type rebootControlState struct {
	Machine     p.MachineKey               `json:"machine"`
	Certificate p.CertificateResponse      `json:"certificate"`
	Observed    p.Installation             `json:"observed"`
	Job         *p.Job                     `json:"job,omitempty"`
	Reports     map[string]p.ReportRequest `json:"reports"`
	Seen        map[string]bool            `json:"seen"`
	Heartbeats  int                        `json:"heartbeats"`
	ArchiveFile string                     `json:"archiveFile,omitempty"`
}

func rebootGuard(t *testing.T) string {
	t.Helper()
	requested := os.Getenv("LEVIATHAN_UPDATER_REBOOT_HOST_UUID")
	if requested == "" || os.Getenv("LEVIATHAN_UPDATER_DISPOSABLE_HOST") != "1" {
		t.Skip("requires explicit exact-host reboot acceptance authorization")
	}
	if os.Geteuid() != 0 {
		t.Fatal("reboot acceptance requires root")
	}
	actual, err := os.ReadFile("/sys/class/dmi/id/product_uuid")
	if err != nil || len(requested) != 36 || !strings.EqualFold(strings.TrimSpace(string(actual)), requested) {
		t.Fatal("reboot acceptance host identity does not match")
	}
	return strings.ToLower(requested)
}

func bootID(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(data))
}

func prepareRebootAcceptance(t *testing.T, setup *setupFixture, control *hostFixtureControl, cfg Config) {
	t.Helper()
	uuid := rebootGuard(t)
	for _, path := range []string{filepath.Join(rebootAcceptanceDir, "fixture.json"), "/etc/systemd/system/" + rebootControlUnit} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("refusing existing reboot fixture", path)
		}
	}
	if err := os.Mkdir(rebootAcceptanceDir, 0700); err != nil {
		t.Fatal(err)
	}
	origin, err := url.Parse(cfg.ControlPlaneURL)
	if err != nil || origin.Hostname() != "127.0.0.1" {
		t.Fatal("reboot fixture must remain loopback-only")
	}
	fixture := rebootFixtureConfig{HostUUID: uuid, InitialBootID: bootID(t), Address: origin.Host, Config: cfg}
	baseline, err := NewSystemdService(cfg).Probe(context.Background())
	if err != nil {
		t.Fatal("cannot retain the required pre-boot domains", err)
	}
	fixture.RequiredSystem, fixture.RequiredGPU = baseline.SystemAvailable, baseline.GPUAvailable
	if err := atomicJSON(filepath.Join(rebootAcceptanceDir, "fixture.json"), fixture); err != nil {
		t.Fatal(err)
	}
	certificate := setup.server.TLS.Certificates[0]
	key, err := x509.MarshalPKCS8PrivateKey(certificate.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	hostWrite(t, filepath.Join(rebootAcceptanceDir, "tls.crt"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]}), 0600)
	hostWrite(t, filepath.Join(rebootAcceptanceDir, "tls.key"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0600)
	clear(key)
	// Transfer the exact fixture endpoint/certificate after the complete suite.
	// Never change the authorized installation's control URL or fingerprint.
	hostCommand(t, "systemctl", "stop", "leviathan-updater.service")
	persistRebootControl(t, control)
	setup.server.Close()
	unit := "[Unit]\nDescription=Disposable Leviathan acceptance control fixture\nAfter=local-fs.target\nBefore=leviathan-updater.service\n[Service]\nType=simple\nUser=root\nUMask=0077\nEnvironment=LEVIATHAN_UPDATER_DISPOSABLE_HOST=1\nEnvironment=LEVIATHAN_UPDATER_REBOOT_HOST_UUID=" + uuid + "\nExecStart=/root/updater-package/automatic-setup.test -test.run ^TestSystemdRebootControl$ -test.timeout=0\nRestart=on-failure\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=" + rebootAcceptanceDir + "\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n[Install]\nWantedBy=multi-user.target\n"
	hostWrite(t, "/etc/systemd/system/"+rebootControlUnit, []byte(unit), 0644)
	hostCommand(t, "systemctl", "daemon-reload")
	hostCommand(t, "systemctl", "enable", "--now", rebootControlUnit)
	waitHost(t, 20*time.Second, func() bool {
		connection, err := net.DialTimeout("tcp", fixture.Address, time.Second)
		if err != nil {
			return false
		}
		connection.Close()
		return true
	})
	hostCommand(t, "systemctl", "enable", "leviathan-update-unrelated-workload.service")
	hostCommand(t, "systemctl", "start", "leviathan-updater.service")
}

func persistRebootControl(t *testing.T, control *hostFixtureControl) {
	t.Helper()
	control.Lock()
	defer control.Unlock()
	state := rebootControlState{Machine: control.machine, Certificate: control.cert, Observed: control.observed,
		Job: control.job, Reports: control.reports, Seen: control.seen, Heartbeats: control.heartbeats}
	if control.job != nil {
		state.ArchiveFile = "pending-archive.tar.gz"
		path := filepath.Join(rebootAcceptanceDir, state.ArchiveFile)
		// Only replace the archive when a new job is queued, not on every heartbeat.
		if body, err := os.ReadFile(path); err != nil || sum(body) != sum(control.archive) {
			hostWrite(t, path, control.archive, 0600)
		}
	}
	if err := atomicJSON(filepath.Join(rebootAcceptanceDir, "control.json"), state); err != nil {
		t.Fatal(err)
	}
}

func loadRebootFixture(t *testing.T) rebootFixtureConfig {
	t.Helper()
	uuid := rebootGuard(t)
	var fixture rebootFixtureConfig
	if err := readJSON(filepath.Join(rebootAcceptanceDir, "fixture.json"), &fixture); err != nil || fixture.HostUUID != uuid {
		t.Fatal("missing or mismatched persistent reboot fixture", err)
	}
	return fixture
}

// The test binary doubles as a TEST-ONLY fixture service across reboots. It
// persists request nonces and terminal outcomes before returning HTTP replies.
func TestSystemdRebootControl(t *testing.T) {
	fixture := loadRebootFixture(t)
	var state rebootControlState
	if err := readJSON(filepath.Join(rebootAcceptanceDir, "control.json"), &state); err != nil {
		t.Fatal(err)
	}
	control := &hostFixtureControl{t: t, machine: state.Machine, cert: state.Certificate, observed: state.Observed,
		job: state.Job, reports: state.Reports, seen: state.Seen, heartbeats: state.Heartbeats, completed: make(chan p.ReportRequest, 16)}
	if state.ArchiveFile != "" {
		if state.ArchiveFile != "pending-archive.tar.gz" {
			t.Fatal("unexpected fixture archive path")
		}
		archive, err := os.ReadFile(filepath.Join(rebootAcceptanceDir, state.ArchiveFile))
		if err != nil {
			t.Fatal(err)
		}
		control.archive = archive
	}
	var gate sync.Mutex
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gate.Lock()
		defer gate.Unlock()
		// This fixed local-only command queues one signed test candidate. It is
		// absent from product binaries and cannot select arbitrary paths/commands.
		if r.URL.Path == "/fixture/queue-reboot-crash" {
			if r.Method != http.MethodPost {
				w.WriteHeader(405)
				return
			}
			control.Lock()
			pending := control.job != nil
			_, completed := control.reports["reboot-crash"]
			control.Unlock()
			if pending || completed {
				w.WriteHeader(409)
				return
			}
			seed := sha256.Sum256([]byte("Leviathan automatic setup acceptance fixture"))
			key := ed25519.NewKeyFromSeed(seed[:])
			enqueueGeneratedUpdate(t, control, key, "reboot-crash", "agent-setup-future", "0.4.4", strings.Repeat("4", 40))
			clear(key)
			persistRebootControl(t, control)
			w.WriteHeader(204)
			return
		}
		response := httptest.NewRecorder()
		control.ServeHTTP(response, r)
		persistRebootControl(t, control)
		for name, values := range response.Header() {
			w.Header()[name] = values
		}
		w.WriteHeader(response.Code)
		_, _ = w.Write(response.Body.Bytes())
	})
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	server := &http.Server{Addr: fixture.Address, Handler: handler, ReadHeaderTimeout: 5 * time.Second,
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS13}}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	if err := server.ListenAndServeTLS(filepath.Join(rebootAcceptanceDir, "tls.crt"), filepath.Join(rebootAcceptanceDir, "tls.key")); err != http.ErrServerClosed {
		t.Fatal("persistent loopback fixture failed", err)
	}
}

func bootAcceptanceEvidence(t *testing.T, fixture rebootFixtureConfig) map[string]any {
	t.Helper()
	currentBoot := bootID(t)
	if currentBoot == fixture.InitialBootID {
		t.Fatal("whole-machine reboot did not occur")
	}
	if hostCommand(t, "systemctl", "is-active", "leviathan-updater-recover.service") != "active" {
		t.Fatal("boot recovery is not active")
	}
	readMicros := func(unit, property string) uint64 {
		value, err := strconv.ParseUint(hostCommand(t, "systemctl", "show", unit, "--property="+property, "--value"), 10, 64)
		if err != nil || value == 0 {
			t.Fatal("missing boot ordering evidence", unit, property)
		}
		return value
	}
	recoveryExit := readMicros("leviathan-updater-recover.service", "ExecMainExitTimestampMonotonic")
	monitorStart := readMicros(fixture.Config.Service, "ExecMainStartTimestampMonotonic")
	if monitorStart < recoveryExit {
		t.Fatal("monitor started before offline recovery finished")
	}
	probe, err := NewSystemdService(fixture.Config).Probe(context.Background())
	if err != nil {
		t.Fatal("post-boot live probe failed", err)
	}
	var state rebootControlState
	if err := readJSON(filepath.Join(rebootAcceptanceDir, "control.json"), &state); err != nil {
		t.Fatal(err)
	}
	if probe.RunningSHA256 != state.Observed.BinarySHA256 || probe.Build.Version != state.Observed.Version {
		t.Fatal("post-boot live executable does not match observed installation")
	}
	if (fixture.RequiredSystem && !probe.SystemAvailable) || (fixture.RequiredGPU && !probe.GPUAvailable) {
		t.Fatal("whole-machine reboot lost a required telemetry domain")
	}
	fingerprint, err := ConfigurationFingerprint(fixture.Config)
	if err != nil || fingerprint != state.Observed.ConfigSHA256 {
		t.Fatal("post-boot configuration changed")
	}
	if hostCommand(t, "systemctl", "is-active", "leviathan-update-unrelated-workload.service") != "active" {
		t.Fatal("sentinel workload did not return after reboot")
	}
	target, err := currentTarget(fixture.Config)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{"hostUuid": fixture.HostUUID, "bootId": currentBoot, "initialBootId": fixture.InitialBootID,
		"recoveryExitMonotonicUs": recoveryExit, "monitorStartMonotonicUs": monitorStart, "currentTarget": target,
		"binarySha256": probe.RunningSHA256, "version": probe.Build.Version, "commit": probe.Build.Commit,
		"sampledAt": probe.SampledAt, "systemAvailable": probe.SystemAvailable, "gpuAvailable": probe.GPUAvailable,
		"configurationSha256": fingerprint, "sentinelActive": true}
}

func TestSystemdRebootHealthyAcceptance(t *testing.T) {
	fixture := loadRebootFixture(t)
	if _, err := os.Stat(filepath.Join(fixture.Config.StateDirectory, "transaction.json")); !os.IsNotExist(err) {
		t.Fatal("unexpected pending transaction after healthy reboot")
	}
	var state rebootControlState
	if err := readJSON(filepath.Join(rebootAcceptanceDir, "control.json"), &state); err != nil {
		t.Fatal(err)
	}
	engine, err := NewEngine(fixture.Config, nil, NewSystemdService(fixture.Config), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.verify(context.Background(), state.Observed, Probe{SystemAvailable: fixture.RequiredSystem, GPUAvailable: fixture.RequiredGPU}, ""); err != nil {
		t.Fatal(err)
	}
	evidence := bootAcceptanceEvidence(t, fixture)
	if err := atomicJSON(filepath.Join(rebootAcceptanceDir, "healthy-reboot-receipt.json"), evidence); err != nil {
		t.Fatal(err)
	}
	t.Log("whole-machine healthy reboot verified; boot recovery completed before monitor startup")
}

func TestSystemdRebootPrepareInterruptedUpdate(t *testing.T) {
	fixture := loadRebootFixture(t)
	var healthy map[string]any
	if err := readJSON(filepath.Join(rebootAcceptanceDir, "healthy-reboot-receipt.json"), &healthy); err != nil || healthy["bootId"] != bootID(t) {
		t.Fatal("healthy whole-machine reboot must pass before interrupted-update reboot")
	}
	client := &http.Client{Timeout: 15 * time.Second}
	response, err := client.Post(fixture.Config.ControlPlaneURL+"/fixture/queue-reboot-crash", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatal("fixture did not queue the approved reboot candidate", response.StatusCode)
	}
	var pending journal
	waitHost(t, 60*time.Second, func() bool {
		return readJSON(filepath.Join(fixture.Config.StateDirectory, "transaction.json"), &pending) == nil && pending.Job.ID == "reboot-crash" && pending.Phase == "verifying"
	})
	hostCommand(t, "systemctl", "kill", "--kill-who=main", "--signal=KILL", "leviathan-updater.service")
	hostCommand(t, "systemctl", "stop", "leviathan-updater.service")
	var retained journal
	if err := readJSON(filepath.Join(fixture.Config.StateDirectory, "transaction.json"), &retained); err != nil || retained.Job.ID != "reboot-crash" || retained.Phase != "verifying" {
		t.Fatal("could not retain an interrupted verification journal")
	}
	witness := map[string]any{"hostUuid": fixture.HostUUID, "bootId": bootID(t), "jobId": retained.Job.ID, "phase": retained.Phase,
		"previousTarget": retained.PreviousTarget, "candidateTarget": retained.Target, "previous": retained.Previous,
		"requiredSystem": retained.Baseline.SystemAvailable, "requiredGPU": retained.Baseline.GPUAvailable}
	if err := atomicJSON(filepath.Join(rebootAcceptanceDir, "interrupted-before-reboot.json"), witness); err != nil {
		t.Fatal(err)
	}
	t.Log("updater killed and stopped with an intact verifying journal; operator reboot is now required")
}

func TestSystemdRebootInterruptedAcceptance(t *testing.T) {
	fixture := loadRebootFixture(t)
	var witness struct {
		HostUUID        string         `json:"hostUuid"`
		BootID          string         `json:"bootId"`
		JobID           string         `json:"jobId"`
		Phase           string         `json:"phase"`
		PreviousTarget  string         `json:"previousTarget"`
		CandidateTarget string         `json:"candidateTarget"`
		Previous        p.Installation `json:"previous"`
		RequiredSystem  bool           `json:"requiredSystem"`
		RequiredGPU     bool           `json:"requiredGPU"`
	}
	if err := readJSON(filepath.Join(rebootAcceptanceDir, "interrupted-before-reboot.json"), &witness); err != nil || witness.BootID == bootID(t) || witness.HostUUID != fixture.HostUUID || witness.JobID != "reboot-crash" {
		t.Fatal("missing exact-host interrupted whole-machine reboot witness", err)
	}
	waitHost(t, 4*time.Minute, func() bool {
		var state rebootControlState
		if readJSON(filepath.Join(rebootAcceptanceDir, "control.json"), &state) != nil {
			return false
		}
		result, ok := state.Reports["reboot-crash"]
		return ok && result.Status == p.RolledBack && result.InstallationVerified && result.Installation == witness.Previous
	})
	waitHost(t, 30*time.Second, func() bool {
		_, err := os.Stat(filepath.Join(fixture.Config.StateDirectory, "transaction.json"))
		return os.IsNotExist(err)
	})
	evidence := bootAcceptanceEvidence(t, fixture)
	if evidence["currentTarget"] != witness.PreviousTarget || (witness.RequiredSystem && evidence["systemAvailable"] != true) || (witness.RequiredGPU && evidence["gpuAvailable"] != true) {
		t.Fatal("offline recovery lost the previous executable or a required domain")
	}
	evidence["interruptedBootId"], evidence["interruptedJobId"], evidence["verifiedRollback"] = witness.BootID, witness.JobID, true
	if err := atomicJSON(filepath.Join(rebootAcceptanceDir, "interrupted-reboot-receipt.json"), evidence); err != nil {
		t.Fatal(err)
	}
	t.Log("whole-machine interrupted update recovered the previous exact executable before monitor startup and verified rollback")
}

// Keep fixture config JSON coverage in ordinary Linux test runs without
// starting services, networking, or touching any privileged installation path.
func TestRebootFixtureJSONRoundTrip(t *testing.T) {
	want := rebootFixtureConfig{HostUUID: "host", InitialBootID: "boot", Address: "127.0.0.1:12345"}
	encoded, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var got rebootFixtureConfig
	if err := json.Unmarshal(encoded, &got); err != nil || got.HostUUID != want.HostUUID || got.Address != want.Address {
		t.Fatal("fixture round trip failed", err)
	}
}
