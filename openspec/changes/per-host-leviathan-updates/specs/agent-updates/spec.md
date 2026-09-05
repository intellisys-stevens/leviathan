## ADDED Requirements

### Requirement: Explicit per-host authority

The system SHALL permit an active administrator or an explicitly delegated
active maintainer to request one Leviathan update for an exact MachineKey.
Only administrators SHALL manage delegations and updater enrollment. Browser
mutations SHALL require a valid session, fresh passkey assertion, matching
Origin/Host and valid CSRF proof.

#### Scenario: Visibility does not imply update permission
- **GIVEN** a user owns or can view a machine but has no update delegation
- **WHEN** the user requests an update for that machine
- **THEN** the system denies the request without creating an installable job.

#### Scenario: Permission changes before activation
- **GIVEN** a queued job whose actor, initiating session or host authority is revoked
- **WHEN** the updater requests final installation authorization
- **THEN** the system denies authorization and the host does not activate the target.

### Requirement: Separate authenticated update protocol

The system SHALL keep update commands out of Uplink and viewer sessions.
Updater enrollment and renewal SHALL bind a dedicated certificate purpose to
one exact MachineKey. Signed requests SHALL bind method, path, timestamp,
nonce and payload, with durable replay rejection. Existing viewer identities
and accounting schema 19 SHALL remain compatible through additive changes.

#### Scenario: Wrong identity or replay
- **GIVEN** a viewer-purpose, wrong-host or revoked certificate, or a consumed nonce
- **WHEN** a caller requests claim, artifact access or installation authorization
- **THEN** the system denies the request without authorizing installation.

#### Scenario: Server restart
- **GIVEN** a signed request nonce was already consumed
- **WHEN** the same request arrives after a server restart
- **THEN** the durable replay check still rejects it.

### Requirement: Trusted compatible stable releases

The system SHALL accept only approved official Leviathan stable artifacts
with verified source/workflow provenance and a canonical manifest signed
outside Yggdrasil. The server and host SHALL verify manifest signatures,
archive/binary digests and bounds. Eligibility SHALL require compatible Linux
architecture, glibc and updater protocol, exact configuration/state profiles,
a managed recognized baseline and a newer stable version.

#### Scenario: Tampered or incompatible target
- **GIVEN** changed artifact bytes, an invalid signature or incompatible metadata
- **WHEN** the target is queued, fetched or checked before activation
- **THEN** validation fails closed and the existing installation remains active.

#### Scenario: Preview baseline
- **GIVEN** a recognized preview was adopted explicitly by the local operator
- **WHEN** a stable target is evaluated
- **THEN** its version must be newer than the preview, allowing that preview's
  own stable version but rejecting any older stable base version.

### Requirement: Durable bounded jobs

The server SHALL retain at most one active job per exact host and make
creation idempotent by actor/request UUID. A job SHALL pin the target signed
manifest and verified starting installation. Unstarted jobs SHALL expire
after 30 minutes. Final authorization SHALL recheck current authority and
installation and permit activation for only 45 seconds; retries SHALL retain
that deadline. Installing jobs SHALL not be silently expired or replaced.

#### Scenario: Duplicate or uncertain creation result
- **GIVEN** creation succeeded but its response was lost
- **WHEN** the same actor retries the same machine/artifact/request UUID
- **THEN** the server returns the original durable job without another install.

#### Scenario: Expired authorization
- **GIVEN** the final authorization deadline has passed
- **WHEN** the host would activate the staged release
- **THEN** it does not activate that release under the expired authorization.

### Requirement: Independent local transaction and recovery

The host SHALL use a separate root-owned updater that polls with a 15-second
baseline, jitter and bounded backoff. Locally registered fixed service/path
settings SHALL determine the only executable that can be updated. The updater
SHALL stage a verified release, preserve the prior installation, use an atomic
activation pointer and persist a journal before mutation. It SHALL neither
update itself nor execute remote paths, hooks or arbitrary commands.

#### Scenario: Monitor fails during update
- **GIVEN** the new monitoring process fails startup or sustained health validation
- **WHEN** the updater evaluates the transaction
- **THEN** it restores and verifies the previous release or records
  `recovery_required` and blocks subsequent updates.

#### Scenario: Process interruption or control-plane outage
- **GIVEN** activation was interrupted or result delivery is unavailable
- **WHEN** the independent updater or boot recovery runs
- **THEN** it resolves the existing journal locally before further updates,
  without reinstalling an already completed operation, and retries reporting.

### Requirement: Verified health and retained state

Success SHALL require the exact target binary/version/commit and 60 continuous
seconds of advancing fresh health observations. The host SHALL retain baseline
system/GPU monitoring capabilities as appropriate to that machine, existing
configuration/history and unrelated GPU workloads. Unverifiable recovery SHALL
not be represented as successful installation or verified rollback.

#### Scenario: CPU-only or GPU host
- **GIVEN** an AMD64 or ARM64 CPU-only host, or a host with available GPU monitoring
- **WHEN** the target is checked after activation
- **THEN** CPU-only success requires usable system telemetry without a GPU,
  and GPU-host success also preserves the prior GPU monitoring capability.

#### Scenario: Successful stable update
- **GIVEN** the target passes all sustained checks
- **WHEN** success is reported
- **THEN** the exact target is active, configuration/history remain retained
  and the terminal result cannot be rewritten to a different outcome.

### Requirement: Deliberate accessible host controls

Existing machine-detail/live views SHALL show installed version/commit,
eligible stable targets, updater enrollment/online status and update outcomes.
The UI SHALL honor server permissions and eligibility, disable duplicate
in-flight actions, retain request UUIDs for uncertain retries and announce
progress/failure accessibly. Enrollment SHALL require deliberate administrator
action; tokens SHALL not enter URLs, logs or persistent browser storage.

#### Scenario: Disabled, unenrolled or unavailable host
- **GIVEN** the feature is disabled, the updater is not enrolled, or it is offline
- **WHEN** the machine view is opened
- **THEN** it shows no enabled update action and presents unavailable/setup
  status without repeated disabled-endpoint errors.

#### Scenario: Delegated maintainer without inventory ownership
- **GIVEN** an active user has an exact-host update delegation but an empty
  authorized Fleet inventory
- **WHEN** the user opens the update host chooser
- **THEN** the separate directory lists only hosts they may update and permits
  selecting that host for an update without granting telemetry or viewer access.

#### Scenario: Leaving a host view
- **GIVEN** status polling or a displayed enrollment token belongs to one host
- **WHEN** the view closes or changes host
- **THEN** old polling is aborted and the old token is removed from the view.

#### Scenario: Enrollment token expires
- **GIVEN** an enrollment token is displayed
- **WHEN** its expiry is reached
- **THEN** the token is cleared and a new deliberate request is needed to
  generate another token.

### Requirement: Gated rollout

The feature SHALL remain disabled by default. Test-host bootstrap, release-key
provisioning, official stable publication/import, enrollment, failure-injection
acceptance and production enablement SHALL be separate explicit operational
gates. Local test success SHALL not imply those gates have passed.

#### Scenario: Source change is ready for review
- **GIVEN** source and local checks are complete but no production enrollment is approved
- **WHEN** the change is delivered
- **THEN** production remains unchanged and the remaining operational gates
  are reported as incomplete.
