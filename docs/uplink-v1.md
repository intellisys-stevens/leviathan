# Yggdrasil Uplink v1

Leviathan's uplink sends a sanitized latest-only observation from the collector
already owned by `leviathan serve`. It does not start another collector, retain
an offline queue, accept commands, or identify the authoritative platform
machine. Yggdrasil resolves that identity from the machine credential.

This is an outbound ingestion path, not a remote Leviathan login. Operators
open the authorized machine view at the central Yggdrasil HTTPS origin. The
browser never connects to the Jetstream VM's public IP, and enabling this
uploader does not expose Leviathan's loopback API or embedded HTML.

## Configuration

The default interval is 15 seconds and the accepted range is one second through
one hour. The origin must be HTTPS and may not contain credentials, a path,
query parameters, or a fragment. Unknown TOML fields fail startup.

```toml
[uplink]
enabled = true
base_url = "https://yggdrasil.example.edu"
token_file = "/run/credentials/leviathan@root.service/leviathan-uplink-token"
interval = "15s"
```

The token has this exact format:

```text
yv1_<22-character base64url lookup ID>_<43-character base64url secret>
```

The lookup ID encodes 16 bytes and the secret encodes 32 bytes without padding.
Keep the provisioned source at `/etc/leviathan/uplink.token`, owned by root with
mode 0600. Never put the token value in TOML, an environment variable, process
arguments, or logs. The bearer token selects the exact Yggdrasil machine record;
the payload does not assert a provider or authoritative machine identity.

## systemd network opt-in

The hardened root unit denies all non-loopback network traffic by default. To
enable uplink, copy
`contrib/systemd/leviathan@root.service.d/20-uplink.example.conf` to
`20-uplink.conf`, replace its TEST-NET address with Yggdrasil's fixed IP or
narrow CIDR, and reload systemd. The drop-in uses `LoadCredential`, whose
runtime path matches `token_file` above. It also points the root service at
`/etc/leviathan/config.toml`, because the hardening policy intentionally hides
root's home directory.

Prepare the root-owned files and install the opt-in drop-in:

```bash
sudo install -d -m 0700 /etc/leviathan
sudo install -m 0600 /path/to/config.toml /etc/leviathan/config.toml
sudo install -m 0600 /path/to/provisioned.token /etc/leviathan/uplink.token
sudo install -D -m 0644 \
  contrib/systemd/leviathan@root.service.d/20-uplink.example.conf \
  /etc/systemd/system/leviathan@root.service.d/20-uplink.conf
sudoedit /etc/systemd/system/leviathan@root.service.d/20-uplink.conf
sudo systemctl daemon-reload
sudo systemctl restart leviathan@root.service
```

Before restarting, put the `[uplink]` block shown above in
`/etc/leviathan/config.toml` and replace the example `base_url`. The
`token_file` value continues to name the systemd runtime credential path, not
the source file in `/etc`.

Do not broaden the allow rule to the entire internet. If Yggdrasil uses multiple
stable addresses, add one `IPAddressAllow=` line for each exact address or
narrow range.

## Wire and retry behavior

The agent sends `POST /api/uplink/v1/snapshots` with a five-second request
timeout and an exact 8 MiB maximum encoded body. Redirects, cookies, ambient
HTTP proxies, and response-body error details are rejected or discarded.

Each process start creates a random 128-bit stream ID and sequences logical
uploads from one. A retry of the same observation retains the same stream ID and
sequence; a newer collector observation replaces the failed one and receives a
new sequence. Startup is spread across one interval, normal and backoff delays
have ten percent jitter, exponential backoff starts at five seconds and caps at
five minutes, and a valid `Retry-After` is honored within that cap.

Yggdrasil owns the canonical contract. Leviathan vendors its byte-identical
OpenAPI document in `api/uplink-v1-openapi.yaml`, records its provenance and
spec/golden hashes in `api/uplink-v1-contract.lock`, and generates the local Go
DTOs in `internal/uplink/contract.gen.go`. Refresh the vendor copy from an
authorized Yggdrasil checkout with:

```bash
scripts/sync-uplink-contract.sh /path/to/yggdrasil
```

`scripts/verify-uplink-contract.sh` is an independent CI gate for the vendored
spec, shared golden payload, and generated code. Processes, users, command
lines, attribution, PCI bus IDs, backing device identifiers, filesystem UUIDs,
metric error messages, and raw diagnostic detail are absent by construction.

CPU-only machines send a valid observation with an empty GPU list and degraded
overall health. GPU initialization or sampling failure does not stop system
snapshots or uploads. The local `/healthz` endpoint returns `200 degraded` while
at least one telemetry domain remains usable and `503 unavailable` only when no
domain has a valid snapshot.
