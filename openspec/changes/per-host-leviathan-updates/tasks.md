# Per-host Leviathan updates tasks

Checked implementation items record code present in the feature worktrees.
Validation and operational gates are recorded separately; no checked source
item implies deployment readiness. Keep this file identical in both repos.

## Implementation present

- [x] Add the shared versioned update/release DTOs and purpose-separated
  updater authentication alongside existing viewer behavior.
- [x] Add Yggdrasil's default-off configuration, exact-host delegation,
  durable idempotent job/audit store and verified stable catalog endpoints.
- [x] Add the independent local updater, fixed service registry, signed
  download validation, durable activation journal and local recovery path.
- [x] Add explicit bootstrap/systemd units and protected stable-release
  manifest/provenance packaging workflows.
- [x] Add machine-detail/live UI, server-driven eligibility, fresh-passkey
  mutations, duplicate-request protection and deliberate enrollment setup.
- [x] Preserve machine identity for live-view controls during telemetry failure.
- [x] Add the independent permitted-host chooser and regression coverage for
  a delegated non-owner selecting/updating a host with an empty Fleet inventory.

## Local validation

- [x] Run frontend Vitest: 53 files and 278 tests passed on 2026-09-05.
- [x] Run all 88 existing Playwright checks, frontend format, lint and production build.
- [x] Run frontend lint and TypeScript/production build on Node 24.19.0;
  refresh the embedded dashboard assets. The existing large-chunk warning
  remains informational.
- [x] Inspect desktop and 360px layouts in light/dark themes; local fixture
  accessibility checks reported no WCAG 2A/AA or 2.1 AA violations, no
  horizontal overflow and 44px updater button targets.
- [x] Run Go, race, protocol/golden and additive migration checks in both
  worktrees; record architecture and exact-snapshot limits in the validation reports.
- [x] Run importer/bootstrap/installer/signature/archive-tampering checks;
  record the observed results in the validation reports.
- [x] Complete source and cross-component security/recovery review and fix
  supported findings. Independent Claude review timed out; no retry was made.

## Test-host acceptance gates

- [x] Create isolated disposable CPU test VMs for the authorized acceptance
  work; use separate generated fixture trust and updater-purpose identities.
- [x] Validate packaged systemd egress/write restrictions, non-root monitor,
  API binding, unchanged bootstrap PID and configuration on disposable ARM64.
- [x] Complete a signed fixture update on real ARM64 systemd, verifying exact
  binary/commit, advancing CPU telemetry, unchanged configuration and workload PID.
- [ ] Complete native AMD64 systemd acceptance; the emulated VM loses MainPID
  during daemon-reload despite the original process remaining alive.
- [ ] On a GPU host, verify baseline GPU monitoring and unrelated workloads
  before/after success, failed startup and rollback.
- [x] In server/host integration and unit tests, reject unauthorized users,
  wrong-host/purpose certificates, revoked
  actors/sessions/certificates and replayed requests cannot authorize install.
- [x] Reject tampered archives/manifests, incompatible profiles/architecture/
  glibc and older stable targets, including preview baselines.
- [x] Exercise duplicates and lost responses in server/client tests; real ARM64
  systemd proved terminal-report reconciliation, failed-startup rollback and
  SIGKILL recovery. Local boot-journal boundaries and recovery-required are unit tested.
- [ ] Validate full host reboot/power-loss behavior on the deployment canary.
- [x] Verify 30-minute expiry and 45-second authorization with controlled
  server clocks; real ARM64 updates enforce 60-second sustained health.

## Release and production gates

- [ ] Provision the protected release signing key and required CI permissions.
- [ ] Publish an official stable release and verify its provenance, signed
  manifest, archive and exact source commit before catalog import.
- [ ] Review live proxy routing and additive database/PKI migration evidence;
  preserve schema 19, Uplink and legacy viewer access.
- [ ] Authorize and perform enrollment/bootstrap for each production host.
- [ ] Enable the feature only for the approved rollout after canary evidence,
  rollback readiness and final approval are recorded.
