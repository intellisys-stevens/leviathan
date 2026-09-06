# 🚀 Deployment

Leviathan is a local observability service. It always binds the browser API to a
loopback address; use a private tunnel or proxy instead of exposing the process
directly on a public interface.

## 🔁 Direct operator access

Forward the loopback dashboard over SSH:

```bash
ssh -N -L 1397:127.0.0.1:1397 gpu-host.example
```

Tailscale users can publish the same service privately on the tailnet's standard
HTTPS port:

```bash
sudo tailscale serve --yes --bg --https=443 http://127.0.0.1:1397
```

Both approaches preserve Leviathan's loopback-only server boundary. Restrict
access to operators who are permitted to see GPU topology, processes, and any
configured workspace attribution.

These are direct-administration options, not the Jetstream fleet access path.
In a Yggdrasil deployment, users authenticate at Yggdrasil and select an
authorized machine there; they do not browse to the VM's public IP or sign in
to Leviathan separately.

## ⚙️ User-scoped systemd service

For a host managed through Yggdrasil, use the opt-in
[`install.sh --with-updater` workflow](managed-updates.md#install-leviathan-and-the-updater-together)
to install and enroll both services in one command. It supports a fresh host and
preserves an existing active installation. The plain installer remains a
binary-only installation.

Release archives include a systemd service template. Install it with the binary
and start an instance named for the GPU workload user:

```bash
sudo install -m 0755 leviathan /usr/local/bin/leviathan
sudo install -m 0644 leviathan@.service /etc/systemd/system/leviathan@.service
sudo install -D -m 0644 leviathan.env.example /etc/leviathan/leviathan.env
sudo systemctl daemon-reload
sudo systemctl enable --now "leviathan@${USER}.service"
```

This is the recommended default. Process discovery remains limited to workloads
that the selected Unix user can inspect.

### Persistent health history

The packaged unit creates a private `/var/lib/leviathan-<user>/health-v1`
directory through systemd's `StateDirectory`. This writable state directory
preserves the existing home and filesystem protections, including root mode.
It retains ninety UTC dates of minute health observations; chart metrics remain
in memory. For direct shell runs, the default is
`$XDG_STATE_HOME/leviathan/health-v1` or `~/.local/state/leviathan/health-v1`.
Override it with `LEVIATHAN_HEALTH_DIR` or `--health-dir`; disable local saving
with `LEVIATHAN_HEALTH_ENABLED=false` or `--health-history=false`.

The Status page keeps host uptime, monitor runtime, and healthy observations
separate. Its Yggdrasil connection state comes from validated upload receipts,
not snapshot timestamps or an external availability probe. An acknowledgement
is fresh for `max(3 × uplink interval, 30 seconds)` (45 seconds by default).
A retryable failure with a fresh acknowledgement is degraded; a first failed
attempt, non-retryable rejection, or expired acknowledgement is unavailable.
An unconfigured uploader or one awaiting its first attempt displays **No data**.
Freshness is recomputed on reads and minute observations with monotonic elapsed
time; receipt times, sanitized failure context, and retry times are optional
local API fields. Upload credentials, URLs, response bodies, and payloads are
not exposed or journaled.

Existing `YYYY-MM-DD.ndjson` records keep their original version-one schema.
Yggdrasil observations use version-one `uplink-YYYY-MM-DD.ndjson` sidecars in
the same private directory. Both retain ninety UTC dates, preserve unknown
gaps, validate private regular files, and share the existing lifetime
`writer.lock` ownership. The sidecar has a separate writer and bounded queue:
disk failures or a full queue disable sidecar saving until restart while live
observations and legacy history continue. Status reports this persistence
failure. Shutdown drains queued records before releasing ownership. Fixture
runs and disabled history remain memory-only.

Restart reloads valid sidecar records, ignores damaged complete rows, and
recovers a truncated final write without inventing observations. Duplicate
minutes and backward-clock repeats cannot overwrite saved samples. A newer
unknown sidecar version is preserved and disables only sidecar saving. Builds
predating link history ignore the `uplink-` filenames, so a rollback can continue writing the
unchanged legacy journal. They will not collect Yggdrasil history during the
rollback; those minutes remain unknown when the newer build returns.
Thirty-day builds can prune older legacy dates, and sidecar-aware thirty-day
builds can also prune older Yggdrasil dates. Preserve a complete health-directory
backup before rollback if all ninety days must remain available. Extending the
window cannot recover dates already removed by a previous build; those gaps
remain unknown.

## 🛡️ Hardened host-wide root mode

Host-wide process discovery requires deliberate privilege expansion. Install the
packaged hardening drop-in and switch service instances:

```bash
sudo install -D -m 0644 \
  leviathan@root.service.d/10-hardening.conf \
  /etc/systemd/system/leviathan@root.service.d/10-hardening.conf
sudo systemctl daemon-reload
sudo systemctl disable --now "leviathan@${USER}.service"
sudo systemctl enable --now leviathan@root.service
```

The drop-in restricts capabilities, filesystems, namespaces, system calls, and
networking while retaining the cross-user `/proc` reads needed for host process
inventory. Root mode makes cross-user process metadata visible to every
dashboard viewer; command lines remain hidden unless explicitly enabled. Read
[Container and workspace permissions](permissions.md#hardened-host-wide-root-mode)
before enabling it.

## ⬆️ Yggdrasil uplink

The optional uploader runs inside `leviathan serve` and consumes the same
immutable snapshots as the local API. It sends the newest sanitized observation
every 15 seconds by default, does not start another collector, and does not keep
an offline queue. It is outbound only and does not make the loopback dashboard
public.

For the hardened root instance, install the opt-in credential/network drop-in
and a root-owned `/etc/leviathan/config.toml`. The drop-in keeps the base unit's
deny-all network policy, adds only the configured Yggdrasil IP or narrow CIDR,
and delivers the bearer token with systemd credentials. See
[Yggdrasil Uplink v1](uplink-v1.md) for the exact configuration, token format,
privacy boundary, and rollout commands.

## ✅ Verification

Confirm the service, API, and browser asset after installation:

```bash
systemctl is-active "leviathan@${USER}.service"
curl -fsS http://127.0.0.1:1397/healthz
curl -fsS http://127.0.0.1:1397/api/v1/version
curl -fsS http://127.0.0.1:1397/api/v1/status
curl -fsSI http://127.0.0.1:1397/leviathan-mark.svg
```

For the root instance, replace `leviathan@${USER}.service` with
`leviathan@root.service`. A healthy CPU-only machine passes `leviathan doctor`
with a GPU warning and returns `200 degraded` from `/healthz`. Use
`leviathan doctor --require-gpu` when missing GPU discovery must fail
verification, or when diagnosing NVML GPM, MIG memory, UVM visibility, or
process permissions.

## 🧯 Rollback

Hosts that opt into approved Yggdrasil updates use the separate root updater,
atomic release directories and offline boot recovery described in
[managed updates](managed-updates.md). Bootstrap is explicit and preserves the
existing service's permissions. The normal installer refuses to overwrite a
managed executable link.

Keep the previous binary until the replacement passes health, telemetry, and UI
checks. Restore it atomically and restart the same service instance if validation
fails. Health journals are versioned; older binaries preserve unknown formats
but apply their own retention to recognized files. Keep a health-directory
backup when rolling back from ninety to thirty days. Metric history still
needs no data conversion. If the older binary predates
health history, remove any newly added `[health]` TOML block before restarting:
the configuration parser rejects unknown fields. The packaged environment
overrides do not require editing the TOML configuration for rollback.
