package updater

import "fmt"

func managedMonitorUnit(c Config) string {
	return fmt.Sprintf(`[Unit]
Description=Leviathan host monitoring
Requires=leviathan-updater-recover.service
After=leviathan-updater-recover.service

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/leviathan --config %s --listen 127.0.0.1:1397 serve
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_SYS_PTRACE
ProtectSystem=strict
ProtectHome=true
ProtectProc=default
ProcSubset=all
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
IPAddressDeny=any
IPAddressAllow=localhost
UMask=0077

[Install]
WantedBy=multi-user.target
`, c.AgentConfigFile)
}
func managedSetupUnits(h *setupHost, c Config) map[string]setupFile {
	common := `User=root
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=CAP_SYS_PTRACE
AmbientCapabilities=
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
`
	common += fmt.Sprintf("ReadWritePaths=%s %s %s\n", c.RootDirectory, c.StateDirectory, c.CredentialDirectory)
	executable := h.path("/usr/local/bin/leviathan-updater")
	config := h.path("/etc/leviathan-updater/config.json")
	polling := "[Unit]\nDescription=Leviathan approved host updater\nWants=network-online.target leviathan-updater-recover.service\nAfter=network-online.target leviathan-updater-recover.service\n\n[Service]\nType=simple\n" + common + fmt.Sprintf("ExecStart=%s --config %s run\nRestart=on-failure\nRestartSec=15s\nTimeoutStopSec=360s\n\n[Install]\nWantedBy=multi-user.target\n", executable, config)
	recovery := "[Unit]\nDescription=Leviathan offline update recovery\nBefore=" + c.Service + "\n\n[Service]\nType=oneshot\n" + common + "PrivateNetwork=true\n" + fmt.Sprintf("ExecStart=%s --config %s recover\n", executable, config)
	return map[string]setupFile{
		h.path("/etc/systemd/system/leviathan-updater.service"):                    {[]byte(polling), 0644},
		h.path("/etc/systemd/system/leviathan-updater-recover.service"):            {[]byte(recovery), 0644},
		h.path("/etc/systemd/system/" + c.Service + ".d/30-updater-recovery.conf"): {[]byte("[Unit]\nRequires=leviathan-updater-recover.service\nAfter=leviathan-updater-recover.service\n"), 0644},
	}
}
