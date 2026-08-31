# Jetstream fleet controller

Yggdrasill presents Nidhogg and Jetstream as peer platforms while preserving
the existing single-host Leviathan contract. Nidhogg is still opened directly
at its existing dashboard URL; the Hub does not proxy, reconfigure, or write to
it.

Jetstream no longer requires every instance to join the Tailnet. The scalable
path is one project-scoped Hub plus outbound HTTPS telemetry from instances:

1. the Hub discovers all project instances through Nova;
2. exact Nova `user_id` rules select the creators Leviathan may manage;
3. an instance with Leviathan installed pushes its full snapshot to one HTTPS
   Hub origin; and
4. Nova console output supplies a coarse fallback when no full snapshot is
   available.

Only the Hub's dedicated uplink HTTPS ingress needs a stable reachable address.
Instances initiate outbound requests and do not expose an inbound agent port.
The dashboard remains a separate Tailnet-only service.

## Processes and trust boundaries

`leviathan` and `leviathan-hub` remain independent processes:

- `leviathan` runs beside the NVIDIA driver and samples one host. `leviathan
  uplink` uses the same provider and snapshot-v1 model, discovers its canonical
  instance UUID from the fixed OpenStack link-local metadata endpoint, and
  periodically sends only the newest snapshot.
- `leviathan-hub` never loads NVML or DCGM. It inventories Jetstream, evaluates
  creator policy, receives bounded telemetry, and serves Yggdrasill.
- `nidhogg_dashboard_url` is only an HTTPS link to the existing Nidhogg
  dashboard. Nidhogg routes and Coder attribution remain unchanged.

The Hub has no route that creates, starts, shelves, deletes, or modifies an
OpenStack instance. The optional telemetry POST changes only a bounded
in-memory latest-sample registry.

## Inventory and creator authorization

OpenStack authentication comes only from standard `OS_*` environment
variables. `OS_PROJECT_ID`, the Keystone host, and the Nova host must each
match an exact configured allowlist. System-scoped auth, `all_tenants`,
redirects, non-HTTPS cloud endpoints, and non-allowlisted hosts are rejected.

Nova `user_id` is the authorization identity. `exoCreatorUsername` is retained
only as an advisory display fallback. There are two policy forms:

- `[[instances]]` pins one UUID to one creator and has highest precedence.
  An explicit mismatch fails closed and never falls through to a creator rule.
- `[[creators]]` dynamically manages every current or future instance whose
  authoritative Nova `user_id` exactly matches `creator_id`.

The exact rule has precedence for identity and for an optional direct
`agent_url` binding; it is not a negative telemetry override. With no direct
binding, a correctly pinned active instance may still use globally enabled
console telemetry or the token configured for that same creator.

Wildcards, duplicate IDs, and conflicting creator labels are rejected. A
creator can remain inventory-visible with `telemetry_enabled = false`.

## Telemetry source precedence

For an active, authorized instance, the Hub selects one source:

1. **Exact Leviathan pull binding.** A legacy `[[instances]]` entry with
   `agent_url` and `agent_hostname` remains authoritative. A failed exact
   binding is not silently hidden by a fallback.
2. **Leviathan uplink.** A fresh, authenticated, agent-pushed snapshot provides
   full GPU, MIG, memory, process, and user detail without an inbound VM route.
3. **Exosphere console.** The Hub reads only Exosphere's strict resource-usage
   JSON record from a bounded console tail.

The API and UI label retained observations as `Leviathan agent`, `Leviathan
uplink`, or `Exosphere console`.

Console telemetry is deliberately low fidelity. It can report per-physical-GPU
utilization, but not GPU model, memory, MIG topology, PIDs, guest users, or
commands. Yggdrasill therefore marks those fields unavailable and never treats
console-only coverage as a complete GPU/process inventory.

Nova exposes console output through the `os-getConsoleOutput` server action,
which uses POST despite being read-only. When console fallback is enabled, the
transport admits only this exact JSON action for a canonical UUID in the
configured project, with 1–200 lines and a bounded response. Reboot, rebuild,
delete, unknown actions, extra fields, cross-project paths, queries, and
oversized bodies remain blocked.

## Non-secret Hub configuration

The TOML contains only scope, policy, limits, HTTPS origins, and names of
environment variables. It never contains an OpenStack secret or uplink bearer
token. Uplink is default-off: omit `[uplink]` (or set only `enabled = false`)
unless an explicitly approved pilot accepts the creator-scoped trust boundary.
The complete example below deliberately enables that pilot and must not be
copied into a production configuration by default.

```toml
listen = "127.0.0.1:1398"
refresh_interval = "30s"
agent_timeout = "8s"
agent_stale_after = "60s"
max_concurrent_agents = 4
nidhogg_dashboard_url = "https://nidhogg.example.test/"

[openstack]
allowed_project_ids = ["project-demo"]
allowed_auth_hosts = ["identity.example.test:5000"]
allowed_compute_hosts = ["compute.example.test:8774"]
max_instances = 500
request_timeout = "15s"
console_metrics_enabled = true
console_lines = 200
console_max_age = "5m"
console_max_response_bytes = 262144

[uplink]
enabled = true
listen = "127.0.0.1:1399"
ttl = "2m"
max_sample_age = "2m"
max_future_skew = "30s"
max_body_bytes = 8388608
max_entries = 500
max_retained_bytes = 268435456
max_creator_retained_bytes = 67108864
max_concurrent_requests = 8

[[creators]]
creator_id = "nova-user-a"
creator_username = "owner-a@example.test"
telemetry_enabled = true
uplink_token_env = "LEVIATHAN_UPLINK_OWNER_A_TOKEN"

[[creators]]
creator_id = "nova-user-b"
creator_username = "owner-b@example.test"
telemetry_enabled = true
uplink_token_env = "LEVIATHAN_UPLINK_OWNER_B_TOKEN"
```

During the initial rollout, configure only the approved test creators. Other
project instances remain visible but unmanaged and receive neither console
requests nor telemetry association. Copy `creator_id` only from the
authoritative Nova `user_id`; `creator_username` is a display label, not an
authorization value. Audit legacy `[[instances]]` entries at the same time,
because an exact UUID pin can also make an instance managed.

An existing exact binding remains valid during migration:

```toml
[[instances]]
uuid = "11111111-1111-4111-8111-111111111111"
creator_id = "nova-user-a"
creator_username = "owner-a@example.test"
agent_url = "https://legacy-agent.example.test"
agent_hostname = "legacy-agent"
```

While an exact pull binding exists it remains the dashboard's authoritative
source, even if the Hub accepts an uplink sample for migration testing. Verify
the sender's one-time `Leviathan uplink connected.` message (or a reverse-proxy
202 response), then remove the exact pull entry. The creator rule then covers
that instance and future instances without a new Hub entry.

The parser rejects unknown fields, including inline `token`, `password`,
`openrc`, and application-credential secret fields. Keep the file private
because it still describes infrastructure topology:

```bash
chmod 0600 hub.toml
```

## Hub secrets and OpenStack environment

Supply OpenStack credentials and independent creator tokens through a process
supervisor or secret manager. The values below are names/placeholders only:

```bash
export OS_AUTH_URL="https://identity.example.test:5000/v3"
export OS_APPLICATION_CREDENTIAL_ID="application-credential-id"
export OS_APPLICATION_CREDENTIAL_SECRET
export OS_PROJECT_ID="project-demo"
export OS_REGION_NAME="RegionOne"
export OS_INTERFACE="public"

export LEVIATHAN_UPLINK_OWNER_A_TOKEN
export LEVIATHAN_UPLINK_OWNER_B_TOKEN
```

Use independent random tokens for each creator. A creator token authorizes only
active, managed instances whose current Nova `user_id` matches that creator;
it cannot submit for another configured creator. This is deliberately a
creator-scoped credential: any VM holding it can submit for another eligible VM
owned by that same Nova creator. Treat all instances under one creator as one
uplink trust domain, rotate the creator token after any VM compromise, and do
not reuse it for another creator. Tokens are hashed when the Hub starts;
concurrent requests, request sizes, global retained bytes, per-creator retained
bytes, and retained entries are bounded. The configured request-body limit
multiplied by effective concurrency may not exceed 256 MiB (the defaults use
8 MiB by 8 requests, or 64 MiB). Samples must be fresh, and `sampledAt`
must move strictly forward. A separate bounded watermark remembers an accepted
timestamp through `sampledAt + max_sample_age`, including the permitted future
skew interval, even after the full payload expires. `uplink.ttl` must still be
at least `uplink.max_sample_age` as a conservative retention invariant.

The metadata-service UUID discovery performed by `leviathan uplink` is routing
input, not cryptographic instance attestation. The Hub authorizes that claimed
UUID against fresh Nova inventory and the creator token, but it cannot prove
which VM inside the creator trust domain sent the request. Keep uplink disabled
outside the explicitly approved pilot. Uplink telemetry alone must not drive
security decisions, billing, scheduling, or incident attribution.

## Run the Hub

```bash
go build -o ./bin/leviathan-hub ./cmd/leviathan-hub
./bin/leviathan-hub --config ./hub.toml inventory
./bin/leviathan-hub --config ./hub.toml serve
```

Open Yggdrasill locally at `http://127.0.0.1:1398/platforms`. The top-level
`listen` address serves only the dashboard, fleet read API, events, version, and
health. When uplink is enabled, `uplink.listen` serves only
`POST /api/fleet/v1/uplink/{instanceUUID}`. Both addresses must be distinct
loopback ports; the uplink default is `127.0.0.1:1399`.

To receive VM uplinks, publish only `uplink.listen` through one HTTPS ingress on
the central host. Preserve the original `Authorization` header, disable
request-body logging, cap bodies consistently with `max_body_bytes`, and do not
expose either loopback listener directly over plaintext HTTP. This is one
central network integration, not one Tailnet enrollment per instance.

For a temporary Hub on a developer machine, Tailscale Serve can keep the
dashboard private while Funnel publishes the separate uplink-only port:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:1398
tailscale funnel --bg --https=8443 http://127.0.0.1:1399
```

The instance Hub origin is then the Funnel HTTPS origin including `:8443`.
Never point Funnel at port `1398`: that port contains sensitive fleet inventory
and the Yggdrasill dashboard. Funnel is public ingress; the creator bearer token
and current Nova inventory checks remain the uplink authentication boundary.

## Run an instance uplink

Install the same `leviathan` binary on the instance, inject only that creator's
token, and start:

```bash
export LEVIATHAN_UPLINK_TOKEN
leviathan uplink \
  --hub-url "https://leviathan-hub.example.test" \
  --token-env LEVIATHAN_UPLINK_TOKEN \
  --uplink-interval 15s
```

By default the command obtains the UUID from exactly
`http://169.254.169.254/openstack/latest/meta_data.json`. Proxy use,
redirects, alternate hosts, large responses, duplicate UUID fields, and
non-canonical UUIDs are rejected. This discovery prevents accidental routing
mistakes but does not attest the calling VM. `--instance-uuid` is available for
a controlled diagnostic override.

The sender accepts only a credential-free HTTPS origin, never follows a
redirect, carries no cookies, performs one bounded request per interval, and
keeps no local retry queue. On a transient failure it continues local
collection and retries with the next newest snapshot.

For future instances, place the binary installation, creator-specific token
environment file, and `leviathan uplink` systemd unit in the user's Exosphere
cloud-init boot script. That automates installation once per creator/template;
it does not require collecting SSH passwords or opening inbound ports.

Release archives include `leviathan-uplink@.service` and
`leviathan-uplink.env.example`. Install the environment as
`/etc/leviathan/uplink-<user>.env` with mode `0600`, then enable the matching
template instance. Use an explicit guest account in automation; cloud-init
normally runs as root, so do not rely on `${USER}`:

```bash
sudo install -D -m 0644 \
  ./leviathan-uplink@.service \
  /etc/systemd/system/leviathan-uplink@.service
sudo install -d -m 0755 /etc/leviathan
# Securely create /etc/leviathan/uplink-exouser.env from the example and inject
# only that Nova creator's token, then:
sudo chmod 0600 /etc/leviathan/uplink-exouser.env
sudo systemctl daemon-reload
sudo systemctl enable --now leviathan-uplink@exouser.service
```

Here `<user>`/`%i` is the guest Linux account that runs the collector; it is
not the Nova creator identity. The Hub derives ownership only from Nova
`user_id` and the creator-scoped token. An ordinary guest account sees only
the processes permitted by that VM's `/proc` policy. Do not run this template
as root merely to broaden process visibility: host-wide collection needs a
separately reviewed root unit with restricted capabilities and explicit Hub
egress, as described by the trust boundary in `docs/permissions.md`.
