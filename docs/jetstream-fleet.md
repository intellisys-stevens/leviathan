# Jetstream fleet controller

The Jetstream fleet controller adds a project-scoped view around existing
MIGLens agents. It does not turn Jetstream into a GPU provider and does not
change the single-host snapshot contract.

## Process and platform boundaries

`miglens` and `miglens-hub` are independent processes:

- `miglens` runs beside the NVIDIA driver, samples one host, and keeps serving
  its existing dashboard and `/api/v1/*` API on loopback. Its optional Coder
  attribution remains local to that snapshot.
- `miglens-hub` does not load NVML or DCGM. It periodically reads OpenStack
  inventory and wraps approved agents' unchanged `Snapshot v1` documents in a
  separate fleet state.

The hub UI presents Nidhogg and Jetstream as peer platforms. The
`nidhogg_dashboard_url` setting is only a link to the existing Nidhogg entry.
The hub does not proxy that service, change its routes, or write to its API.

## Three read-only layers

### 1. Inventory

The inventory adapter authenticates from standard `OS_*` environment variables
and lists instances only within the exact `OS_PROJECT_ID`. Configuration must
separately allowlist that project ID, the identity host, and the Nova compute
host selected from the service catalog.

Authentication requires an HTTPS `POST` to the identity token endpoint. After
authentication, the OpenStack transport permits only HTTPS `GET` and `HEAD` to
the allowlisted identity and compute hosts. It rejects redirects,
`all_tenants`, non-allowlisted hosts, and cloud mutation methods. Returned
metadata and tags are discarded rather than copied into fleet state; only the
sanitized inventory fields and creator identity are retained.

### 2. Agent identity

An instance is eligible for an agent probe only when all of these are true:

1. its normalized cloud state is active;
2. its canonical lowercase UUID is explicitly configured;
3. its discovered creator username exactly matches the configured creator; and
4. that UUID has an explicit credential-free HTTPS agent URL and expected
   snapshot hostname.

There are no wildcard UUIDs, creators, projects, or hosts. The agent client
follows no redirect and sends only `GET /api/v1/snapshot` and
`GET /api/v1/version`. It accepts the result only after the snapshot reports
schema `v1` and its hostname exactly matches the binding. Response bodies and
timeouts are bounded, and errors do not include response bodies or URLs.

Instances missing from the exact UUID-and-creator list are still visible in the
sanitized inventory, but remain inventory-only. Shelved, stopped, mismatched,
unknown, or unbound instances receive no successful telemetry association. The
controller never uses an instance name as an identity or authorization key.

### 3. Fleet telemetry

The controller keeps inventory freshness and agent freshness separate. One
unreachable agent does not remove other instances or make the OpenStack
inventory unavailable. A retained agent snapshot is marked stale at the outer
fleet layer rather than rewriting its inner metric provenance.

The hub serves fleet state, server-sent events, version, and health endpoints;
it has no cloud or agent mutation route. It does not retrieve passphrases, make
SSH connections, install software, or change instance lifecycle state.

## Non-secret configuration

The TOML file contains only scope controls, allowlists, and credential-free
HTTPS locations. All values below are synthetic examples:

```toml
listen = "127.0.0.1:1398"
refresh_interval = "30s"
agent_timeout = "8s"
agent_stale_after = "45s"
max_concurrent_agents = 2
nidhogg_dashboard_url = "https://nidhogg.example.test/"

[openstack]
allowed_project_ids = ["project-demo"]
allowed_auth_hosts = ["identity.example.test:5000"]
allowed_compute_hosts = ["compute.example.test:8774"]
max_instances = 100
request_timeout = "10s"

[[instances]]
uuid = "11111111-1111-4111-8111-111111111111"
creator_username = "owner-a@example.test"
agent_url = "https://gpu-agent-a.example.test"
agent_hostname = "gpu-agent-a"

[[instances]]
uuid = "22222222-2222-4222-8222-222222222222"
creator_username = "owner-b@example.test"
agent_url = "https://gpu-agent-b.example.test"
agent_hostname = "gpu-agent-b"
```

An `[[instances]]` entry is an exact authorization pair, not an inventory
filter. Removing an entry stops agent probing but does not hide that instance
from the project inventory. Changing an instance name does not change its UUID
binding.

The parser rejects unknown TOML fields. In particular, do not add an
application-credential secret, token, password, OpenRC body, or SSH material to
this file. Restrict its permissions anyway because the allowlists describe
infrastructure topology:

```bash
chmod 0600 hub.toml
```

## OpenStack environment

Inject credentials into the `miglens-hub` process using standard OpenStack
environment variables. An application credential with only the required
project reader role is recommended. The following names and non-secret values
are illustrative; the secret itself should be supplied by a process supervisor
or secret manager rather than written to TOML or shell history:

```bash
export OS_AUTH_URL="https://identity.example.test:5000/v3"
export OS_APPLICATION_CREDENTIAL_ID="synthetic-credential-id"
export OS_PROJECT_ID="project-demo"
export OS_REGION_NAME="RegionDemo"
export OS_INTERFACE="public"
export OS_APPLICATION_CREDENTIAL_SECRET
```

`OS_PROJECT_ID` must exactly match one `allowed_project_ids` entry. The host in
`OS_AUTH_URL` and the compute endpoint selected from the service catalog must
also exactly match their corresponding host allowlists. System-scoped auth is
rejected.

## Commands

Build the standalone development binary separately from the local agent:

```bash
go build -o ./bin/miglens-hub ./cmd/miglens-hub
```

Verify the sanitized inventory without starting agent polling or the dashboard:

```bash
./bin/miglens-hub --config ./hub.toml inventory
```

Start the loopback-only fleet dashboard:

```bash
./bin/miglens-hub --config ./hub.toml serve
```

Open `http://127.0.0.1:1398/fleet`. For remote access, leave the listener on
loopback and place an authenticated SSH or Tailnet proxy in front of it.
