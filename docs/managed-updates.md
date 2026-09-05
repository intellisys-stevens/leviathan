# Approved host updates

The default installer includes both Leviathan and `leviathan-updater`. Without
Yggdrasil setup information it installs the binaries in `~/.local/bin`; the
updater remains unconfigured. Use `--without-updater` to install only Leviathan.

An enrolled updater polls Yggdrasil over outbound HTTPS every 15 seconds with
jitter and backoff. Later updates require an explicit request for one host and
one compatible stable release. They change only Leviathan, preserve its local
configuration and compatible persistent state, and retain the previous release
for rollback. The updater itself is not replaced by a dashboard update.

## Install Leviathan and the updater together

Deploy Yggdrasil's setup endpoints and import a verified, installer-capable
stable release first. An administrator selects the host, opens **Install
Leviathan and updater**, selects the initial stable release, and chooses
**Copy install command**. Run that exact command on the selected Linux host
within 15 minutes. Root or sudo is required; unattended execution needs root
or existing passwordless sudo.

The command downloads the official release-specific installer and verifies its
pinned digest. That installer verifies the architecture-specific static updater
before executing `leviathan-updater setup`. Setup requires neither Python nor
`gh`. It detects AMD64/ARM64 on the host, verifies the release using public keys
compiled into the official updater, generates configuration and private
credentials, enrolls, starts the services, and reports readiness. No release
keys, JSON, hashes or ingress CIDRs need to be prepared by the user.

The copied command contains a short-lived, single-host capability. It is sent
to the bootstrap over standard input, never in a URL. The host generates its
own key and writes credentials to private files under `CODEX_SECRETS_DIR`
(default `/var/lib/leviathan-updater/secrets`).
Yggdrasil stores the ticket hash and durable public receipt; the raw ticket is
returned only when created. Keep the command private until it expires. The
browser clears it when setup closes, the selected host changes, or it expires.

On a fresh host, setup creates a hardened `leviathan@root.service` and a
separate updater and offline recovery service. The dashboard listens on
loopback and CPU/GPU detection is automatic. Agent configuration is generated
at `/etc/leviathan/config.toml`, updater configuration at
`/etc/leviathan-updater/config.json`, and the durable setup journal at
`/var/lib/leviathan-updater/setup.json`. Existing running installations
are adopted only when a single supported service can be identified safely.
Their running version, configuration, service user and existing credentials
are preserved. Conflicting binaries, multiple services and ambiguous
configuration stop setup with an explanation.

An existing preview requires **Allow adoption of an existing preview** in
Yggdrasil before generating the command. Adoption preserves that preview;
it does not install an older stable release or change later eligibility.
Unknown development versions are not accepted as a baseline.

Setup journals and the locally generated identity survive interrupted
connections and startup. Rerun the same command on the same host to resume or
confirm completion. Another key cannot replay a redeemed ticket. A received
receipt can be retried without recreating the identity. An unstarted expired
command requires a new command; an operation that has started retains its
recovery state. A `recovery_required` result requires local operator inspection.

The updater allows only the configured HTTPS control origin, validates TLS,
and rejects redirects. DNS changes do not require editing a static IP list.
The polling service retains filesystem and capability restrictions; the
separate boot recovery service has no network access. Initial bootstrap needs
access to GitHub release assets; normal updates and artifact downloads use
only the configured Yggdrasil origin.

## Advanced compatibility paths

The following flags and Python bootstrap remain available for existing
operator scripts. They are not required by the README installer or the
Yggdrasil-generated command. Their explicit inputs, dependencies and dry-run
behavior are retained.

## Advanced combined installer

Deploy and enable the approved Yggdrasil canary endpoints and verified release
catalog first. Advanced provisioning scripts can use Yggdrasil's retained
administrator-only `/api/agent-updates/v1/enrollments` endpoint to generate an
updater enrollment token for the exact host. Keep that token in a root-owned mode-0600 file under
`CODEX_SECRETS_DIR`, for example `/etc/leviathan-updater/secrets`. It expires after
15 minutes. Prepare the updater JSON, independently pinned public key, and
registered agent TOML/environment files listed below before running the command.
For a fresh non-root service, the selected Unix user must already exist and must
be able to read the agent TOML; the updater JSON and token remain private to root.
Set `agentEnvironmentFile` to an empty string when no environment file is needed.

Use a reviewed `install.sh` from a trusted checkout, or download the named stable
release's `install.sh` into a root-owned directory and verify its GitHub
attestation using the exact tag/full commit and the policy in
[release verification](releasing.md#managed-update-signing) before running it as
root. Do not substitute a mutable `latest` script for this trust step. The
installer embeds its own verifier: it never downloads a helper to verify itself.
Python 3.11+, OpenSSL with Ed25519 support, `gh` with the documented attestation
flags, systemd and glibc 2.34+ are required. The installer never invokes `sudo` or
creates a Unix user itself.

Replace every example value, then run this on the intended Linux host:

```bash
export CODEX_SECRETS_DIR=/etc/leviathan-updater/secrets
REVIEWED_TAG=vX.Y.Z
REVIEWED_COMMIT='<reviewed-full-40-character-commit>'
sudo sh /root/leviathan-installer/install.sh \
  --with-updater \
  --version "$REVIEWED_TAG" --commit "$REVIEWED_COMMIT" \
  --updater-config /root/leviathan-updater.json \
  --token-file "$CODEX_SECRETS_DIR/host-updater.token" \
  --release-public-key /etc/leviathan-updater/release-public.pem \
  --yggdrasil-cidr 203.0.113.10/32 \
  --dry-run
```

`vX.Y.Z`, the commit, host identity and documentation CIDR are placeholders; the
command refuses them unchanged. After reviewing the dry-run result, repeat the
same command without `--dry-run`. The dry run downloads and verifies temporary
artifacts, validates configuration and service ownership, then removes its
staging files; it does not enroll, install persistent files or change services.
`--with-updater` requires an exact stable release and uses `/usr/local/bin`.
An independently supplied `--release-public-key` must also appear in the updater
configuration's `trustedReleaseKeyFiles`.

The installer verifies official GitHub provenance for both the archive and
manifest, the Ed25519 manifest signature, exact version/commit/platform, glibc
compatibility and archive/binary hashes before executing any packaged helper.
It rejects links, traversal, duplicate paths and oversized archives. It then
validates local inputs and the release's read-only configuration check.

- On a fresh host with no Leviathan executable, service or service drop-ins, it
  enrolls the updater, adopts the signed release directly into the managed
  directory, installs the single registered service, and verifies the exact
  running executable plus advancing telemetry before enabling update polling.
  A root instance uses the packaged root hardening and only the supplied
  Yggdrasil egress ranges; a non-root instance retains the packaged service's
  ordinary hardening. No configuration or environment file is generated from
  guesses.
- On an existing active installation, it adopts the existing executable and
  keeps the running service, Unix user and hardening. The downloaded Leviathan
  executable is not substituted. Subsequent version changes use Yggdrasil's
  approved update workflow. Add `--allow-preview` to deliberately adopt a
  recognized installed preview; that never permits a downgrade.
- On an identically configured managed installation, it preserves the updater
  identity and active release. A conflicting binary, configuration or service
  causes a refusal. An inactive or partly installed unmanaged service requires
  operator reconciliation before adoption.

The combined installer needs GitHub access during this one-time setup. Normal
updater polling and artifact downloads afterwards use only Yggdrasil. If initial
startup fails, the installer stops only the new service it created, reports an
incomplete installation, and retains its enrolled identity and baseline for an
identical retry. Existing active services never enter that cleanup path.

## Advanced standalone bootstrap

Obtain an approved stable release archive and verify its SHA-256 and GitHub
provenance against the official repository, release workflow, exact tag and full
source commit. See [release verification](releasing.md#managed-update-signing).
Stage the verified extracted package in a root-owned directory such as
`/root/leviathan-bootstrap`; its ancestors, updater binary, scripts and systemd
templates must not be writable by another user. This lower-level workflow is for
an existing active service; use the combined installer above for a fresh host.
Python 3 and systemd are required.

Keep the existing monitoring service active with
`ExecStart=/usr/local/bin/leviathan ... serve`. Its explicit `--listen` address
must match the configured loopback API. The service must select the registered
root-owned TOML explicitly through `--config` or a literal `LEVIATHAN_CONFIG`
assignment in the registered environment file. Empty config paths and implicit
HOME/XDG config discovery are refused. The environment file set must match the
registry exactly; extra files, inline environment overrides, inherited/unset
environment directives and unmodeled command flags are rejected. Bootstrap
refuses to replace the service command or
its hardening to force a match; reconcile the intended local configuration first.

Prepare these files as the host administrator:

| File | Ownership and purpose |
| --- | --- |
| `/root/leviathan-updater.json` | Root, mode 0600; copy the packaged `contrib/systemd/leviathan-updater.config.example.json` and set the real origin, machine identity and existing service |
| `/etc/leviathan-updater/release-public.pem` | Root, mode 0644 or stricter; PKIX Ed25519 public key pinned through an independent trusted channel |
| `$CODEX_SECRETS_DIR/host-updater.token` | Root, mode 0600; the one-time token created for this host's updater purpose |
| Existing agent TOML/environment files | Root-owned, not writable by group or others; TOML is required, while an empty environment-file string is allowed only when the service declares no environment file |

The example contains placeholders and cannot enroll a real machine unchanged.
The control-plane and API URLs must be origins without a trailing slash, query,
fragment or embedded credentials. Updater config, state and binaries use fixed
paths. The machine identity must match the Yggdrasil enrollment grant. Do not
reuse viewer certificates, viewer tokens or the Leviathan uplink token.

Supply the current Yggdrasil ingress IPs or approved narrow CIDRs. Every resolved
origin address must fall within the supplied allowlist. `0.0.0.0/0` and `::/0`
are rejected. The legacy bootstrap network drop-in retains its explicit ingress ranges. DNS should use the host's local
resolver. Changing ingress addresses later requires an explicit administrator
change to that updater network drop-in.

## Review and apply

Run the dry run on the intended Linux host. Replace the documentation address
and token path below with the reviewed values:

```bash
sudo /root/leviathan-bootstrap/scripts/bootstrap-updater.sh \
  --config /root/leviathan-updater.json \
  --updater-binary /root/leviathan-bootstrap/leviathan-updater \
  --token-file "$CODEX_SECRETS_DIR/host-updater.token" \
  --yggdrasil-cidr 203.0.113.10/32 \
  --enable-managed-updates --dry-run
```

After reviewing the host, service, key and network scope, run the identical
command without `--dry-run`. Add `--allow-preview` only when intentionally
adopting the current preview. The advanced combined installer invokes this bootstrap only after
`--with-updater` and release verification. The default managed command uses
the static updater setup implementation described above.

Bootstrap validates all inputs before copying. It then installs the updater
and registry, enrolls its separate identity, adopts the exact existing binary,
and atomically changes `/usr/local/bin/leviathan` to
`/opt/leviathan/current/leviathan`. The adopted binary remains at
`/opt/leviathan/releases/<binary-sha256>/leviathan` for rollback. Accepted new
releases use the same binary digest directory scheme. Root owns executable
directories with mode 0755 so the registered non-root service can traverse them;
updater state and identity remain mode 0700/0600.

The only monitored-service change is a dependency on
`leviathan-updater-recover.service`. That separate unit runs without network
access before the monitor starts at boot and resolves an interrupted local
transaction. The polling unit runs after the recovery attempt and can report a
recovery failure even when the monitor's boot dependency remains blocked. Both updater units can
write only `/opt/leviathan` and `/var/lib/leviathan-updater` through their systemd
filesystem sandbox. Bootstrap does not stop or restart the running monitor.

## Interrupted bootstrap and verification

If enrollment fails, the original executable and monitored service remain in
place. Root-owned configuration, the staged updater and the pending enrollment
identity are retained. Rerun with identical inputs: the updater reuses the same
CSR and enrollment receipt. A lost enrollment response must not be handled by
deleting the identity or creating a new key.

If bootstrap is interrupted after adoption, an identical rerun reuses the
adopted release. If the managed executable link is already present, bootstrap
validates updater status and skips adoption. Conflicting configuration,
binaries, keys or unit files fail closed instead of overwriting an existing
deployment. Unexpected recovery state requires local operator inspection.

Verify the completed installation:

```bash
sudo /usr/local/bin/leviathan-updater --config /etc/leviathan-updater/config.json status
systemctl is-active leviathan-updater.service
systemctl status leviathan-updater-recover.service
systemctl is-active leviathan@root.service
readlink /usr/local/bin/leviathan
readlink /opt/leviathan/current
curl -fsS http://127.0.0.1:1397/api/v1/version
```

Use the configured service name if it differs from `leviathan@root.service`.
The normal installer refuses to overwrite a managed symlink, including a
dangling one. An administrator must review recovery status before changing
that link or removing managed state. Retained rollback releases are not
automatically deleted by bootstrap.

Packaging tests run without touching real services:

```bash
python3 scripts/bootstrap-updater-test.py
python3 scripts/install-managed-test.py
python3 scripts/sync-managed-installer.py --check
scripts/install_test.sh
go test ./cmd/leviathan-update-manifest
```

## Validation and operational limits

See [validation evidence](agent-updates-validation.md) before rollout. The
updater reports verification progress only after observing the exact new
running binary, and reports success only after the sustained health window.
A `recovery_required` result remains blocked for operator inspection. Local
chart history is currently an in-memory cache and resets on restart; compatible
persistent files and Yggdrasil's durable history are retained.
