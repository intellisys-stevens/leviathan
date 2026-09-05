# Per-host Leviathan updates design

## Ownership and trust

| Owner | Responsibility | Authority boundary |
| --- | --- | --- |
| Release pipeline | Build and sign stable manifests; publish provenance | Signing private key stays outside Yggdrasil and the host |
| Yggdrasil | Verify the catalog; authorize users and enrolled machines; retain jobs/audit | Sends an immutable release identity, never a command, hook, executable path or arbitrary download URL |
| Leviathan updater | Validate the local installation; stage, activate, verify and recover | Root-owned local configuration selects the fixed monitor service and filesystem locations |
| Existing Leviathan monitor | Serve monitoring and retain configuration/history | Replacing or crashing the monitor cannot terminate the independent updater |

`internal/updateprotocol/protocol.go` is the shared HTTP contract, vendored
without importing the other repository's internal packages. Its update and
release schemas are `leviathan-update-v1` and `leviathan-release-v1`.
Uplink remains telemetry-only. Viewer and updater certificates have separate
purposes and identity namespaces; legacy viewer rows retain their meaning.

## Authorization and protocol

The browser addresses a full `platformId` / `scopeId` / `machineId`. An active
administrator may update a known host; every other user needs an explicit
delegation for that exact key. Ownership, account tier and viewer access do
not imply this permission. Only administrators may change delegations or
issue enrollment tokens. Mutations use the existing fresh-passkey, Origin,
Host and CSRF checks, with no automatic replay after reauthentication.

| Surface | Routes |
| --- | --- |
| Dashboard | `GET /api/agent-updates/v1/status`; `GET /hosts`; `POST /jobs`; `PUT /delegations`; `POST /enrollments`, all under the same browser prefix |
| Updater enrollment | `POST /api/node-control/v1/updates/enroll` |
| Signed updater requests | `renew`, `claim`, `authorize`, `artifact`, `report` under `/api/node-control/v1/updates/` |

Enrollment binds a short-lived token to the machine and updater purpose;
store its digest, never its plaintext. Request authentication binds the
certificate ledger, purpose, method, path, timestamp, nonce and payload.
Nonce consumption is durable across server restarts. A renewal preserves
machine and purpose. Revocation includes the updater issuance lineage.

| Bound | Value and purpose |
| --- | --- |
| Normal host poll | 15 seconds with jitter; bounded failure backoff |
| Updater online observation | Signed heartbeat no older than 90 seconds |
| Unstarted job | Expires after 30 minutes |
| Final install authorization | 45 seconds; a retry retains the original deadline |
| Health acceptance | 60 continuous seconds with advancing fresh samples |
| Enrollment token | 15 minutes; deliberate one-time operator setup |

At final authorization, recheck the actor, initiating session, exact-host
permission, certificate, current installation and pinned artifact. Revocation
before this check prevents installation. The short authorization window
bounds the interval between the last central permission check and activation.

## Release eligibility and installation

Accept only the official Leviathan repository's stable release workflow,
exact tag and source commit, with verified GitHub provenance. The catalog is
read-only to the serving process. Both sides verify the signed canonical
manifest, archive/binary sizes and SHA-256 digests. The host downloads only
from its configured Yggdrasil origin.

Eligibility requires Linux AMD64 or ARM64, compatible glibc and updater
protocol, a recognized managed installation, exact configuration/state
profiles and a strictly newer stable version. A recognized preview may
advance to its own stable version after explicit local adoption; an older
stable version and an unknown development baseline fail closed.

The updater uses one local transaction lock, digest-addressed release
directories, an atomic current-release pointer and a durable journal. Before
activation it checks the service registry, current executable and config
fingerprint again. It changes only the registered monitor executable and
restarts only the registered monitoring service. Existing Unix identity,
configuration, history paths, API binding and unrelated GPU workloads remain
outside the update payload's control. The updater itself is installed out of
band.

Jobs normally progress through queued, downloading, installing and verifying.
Success requires the exact target executable, build identity, fresh advancing
samples and preservation of the baseline system/GPU monitoring capabilities.
CPU-only hosts need no GPU. GPU hosts must retain the GPU capability they had
before the update.

After activation, health checks and rollback use an independent local bounded
context. Failed startup or health validation restores the previous verified
release. Interrupted activation is recovered from the journal before the
monitor starts at boot. If restoration cannot be verified, persist
`recovery_required` and block further updates. Result delivery may be retried
without repeating installation; a central outage must not prevent local
recovery. Terminal reports cannot rewrite a different terminal outcome.

## State and UI semantics

One active job per exact host is enforced durably. A user-scoped request UUID
returns the original job on retry; reuse for another machine or artifact is a
conflict. Audit entries contain identities, transitions and sanitized codes.

Installed-build evidence comes from updater reports, independently of agent
telemetry. Enrollment, online status, managed adoption and successful health
verification are distinct facts. An unverifiable recovery cannot present a
known successful installation merely because the updater is online.

The existing machine cards open updater controls on demand; live views use
the authorized machine identity even when telemetry is unavailable. A Fleet
heading control loads the separate `/hosts` directory and lets an administrator
or exact delegate select a host even when their Fleet inventory is empty.
This directory returns only permitted MachineKeys and grants no inventory,
telemetry or viewer access. The UI
requires server permission, an enrolled online managed host, an eligible
stable target and no active/recovery-required job before enabling update.
Polling stops when unmounted; disabled endpoints do not create repeated
errors. Stage and outcome changes use an accessible live region. Enrollment
tokens remain in memory and clear on close, host change or expiry.

## Opt-in combined installation

`install.sh --with-updater` uses the same bootstrap for initial installation and
existing-service adoption. Its trusted verifier is embedded in the standalone
installer and executes Python in isolated mode. It requires a reviewed stable
version/full commit, prepared root-owned local configuration and token file,
an independently pinned release public key and explicit Yggdrasil egress ranges.
The ordinary installer remains binary-only. The initial installer itself must
come from a trusted checkout or be verified with the official release attestation
policy before root execution; no unsigned remote helper bootstraps trust.

Both archive and manifest must pass exact official GitHub provenance. The pinned
key verifies the canonical signed manifest and archive/binary digests before any
packaged code runs. Safe bounded extraction forbids links and traversal.
Full local preflight and read-only configuration validation precede enrollment
or service mutation; dry run removes temporary downloads and makes no persistent
installation, enrollment or service changes.

An existing active monitor is adopted without substituting the downloaded
binary. Preview adoption remains explicit and never grants downgrade permission.
A genuinely fresh host has neither the registered service/drop-ins nor an
unmanaged executable. After enrollment, bootstrap adopts the signed baseline and
creates only the exact locally registered service using its existing Unix user,
loopback endpoint and explicit configuration. The root instance receives packaged
root hardening and only the supplied network ranges.

A durable local bootstrap intent preserves identity and exact inputs across
interruption. Failed initial startup stops only the newly created service and
retains the baseline for an identical retry; it cannot affect an existing active
monitor. Exact executable identity and advancing telemetry must pass before
bootstrap durably marks the fresh monitor complete and enables autonomous update
polling. This ordering ensures an interrupted retry cannot stop a newer approved
release installed after polling began. Managed reruns preserve the active release;
conflicting inputs or unrelated partial service installations fail closed.

## Operational gates

Keep the central feature disabled by default. Provision the independent release
trust key and verified stable catalog, then deploy and enable the approved canary
control endpoints before issuing host enrollment tokens. Enroll and validate the
canary before separately approving production hosts. Preserve an existing
monitor's hardening; grant only the updater narrow Yggdrasil egress and its fixed
write directories. Local/unit tests do not prove the actual Linux service ordering,
proxy routes, GPU workloads, reboot recovery or production rollback.

## Persistent versus volatile history

Leviathan currently keeps its local chart history in an in-memory ring buffer.
An agent restart clears that volatile cache. The updater preserves existing
configuration and persistent files; Yggdrasil's durable history is unaffected.
This change does not introduce a local history persistence format or migration.
