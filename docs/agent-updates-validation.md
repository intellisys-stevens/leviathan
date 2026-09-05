# Managed update validation

The feature is implemented in fresh `feat/per-host-agent-updates` worktrees.
The review branches use Yggdrasil main
`ac7590e1bd47a48942f53b6f5682fcd3669d22d1` and Leviathan main
`b524433b6b5596892b9b7f366791692af31229f3`.
The feature remains disabled by default. These results are implementation and
disposable-host evidence, not a production release or deployment approval.

## Automatic installer and one-command setup

On 2026-09-05, both main refs above were fetched and verified again. Release
metadata remains `0.4.0`; `scripts/verify-release-metadata.sh 0.4.0` passed.
The `0.4.1` builds below are isolated test fixtures, not a version bump. Normal
installation now installs both binaries through a release-specific shell
bootstrap and the static Go updater. The Yggdrasil command generates local
configuration and credentials, enrolls the selected host, and starts and
verifies the services. The advanced Python/gh path remains available.

Current source validation:

- Full Linux ARM64 and AMD64 Go suites passed; full vet and targeted race checks
  passed. Focused Go/vet/race checks passed again after the final setup recovery
  refinements. macOS is not the authoritative platform for the monitor suite.
- All 60 installer, release-key, advanced-bootstrap and catalog fixtures passed:
  14 default-installer, eight release-installer/key-policy, nine advanced
  installer, 19 bootstrap and ten Yggdrasil catalog-import cases.
- Shared update DTOs, OpenAPI and locks match the companion repository. ShellCheck,
  shell syntax, embedded advanced-script synchronization, branding and release
  metadata checks passed.
- Setup regressions cover standalone opt-out, downgrade and artifact rejection,
  architecture/commit/signature/profile mismatches, supported service and preview
  adoption, concurrent setup, CSR reuse, renewed certificate preservation,
  ticket replacement, interrupted enrollment/startup, lease expiry, sticky
  recovery state, TLS/redirect rejection and unchanged service/configuration.
- Packaging verifies bootstrap hashes and compiled independent release roots.
  Production publication rejects missing roots, known fixture roots and a
  signing key that does not match the public build receipt. Actual Go signer
  interoperability passed for both supported base64 seed/private-key formats.

`TestSystemdAutomaticSetupAcceptance` ran the generated shell installer with the
real static updater on a disposable Ubuntu 24.04 ARM64 systemd host and passed
in 61.75 seconds. Its install PATH contains neither Python nor `gh`. The test
kills setup after the monitor starts, expires the original installation lease,
and repeats the command. Verification resumes for 60 seconds without another
artifact download, authorization grant or monitor restart. Another repeat
preserves the configuration, host key, renewed certificate and unrelated
workload PID. The exact fixture build (`0.4.1`, commit of forty `1` characters)
produces advancing CPU telemetry. The polling unit has no static IP allowlist.

A fresh emulated AMD64 attempt completed setup and sustained health checks,
then failed the retained-PID assertion. The monitor had `NRestarts=0`, and
systemd logged that it could not identify its child process (`Inappropriate
ioctl for device`). Native AMD64 acceptance remains unverified by that attempt.
The CI workflow now runs the same guarded test on disposable native AMD64 and
ARM64 systemd runners; their results must be checked independently.

The shell template's release pins are stamped in the test. A narrow fixture
`curl` substitutes only the official helper download; the shell verifies its
real digest and executes the native helper. Enrollment, artifacts and reports
use an actual TLS fixture with signed manifests. These observations do not
establish official GitHub provenance, a published stable release or a live
Yggdrasil proxy/passkey integration. Disposable VMs retain their fixture disks.

The first live test compared the whole credential file while the updater
legitimately renewed its short-lived fixture certificate. The final test
explicitly waits for renewal and proves the same key and renewed certificate
survive retry; a deterministic unit regression covers the same boundary.

## Earlier current-main integration and advanced installer

On 2026-09-05, a fresh fetch confirmed Leviathan `origin/main` remains
`b524433b6b5596892b9b7f366791692af31229f3`. The companion Yggdrasil branch
was rebased onto `ac7590e1bd47a48942f53b6f5682fcd3669d22d1`, preserving
the new administrator MCP and lifecycle/presentation changes.

The full Leviathan Go suite, full vet and updater/protocol/CLI race checks
passed again as non-root in a Linux ARM64 Go 1.27 Bookworm container. A macOS
full-suite attempt hit existing Linux-only DCGM linker flags and Unix socket
path limits; Linux is the authoritative platform for that suite.

The combined `install.sh --with-updater` path is opt-in and requires an exact
stable version/commit, independent release public key, host configuration,
private enrollment token and explicit egress CIDRs. Its embedded verifier
checks official provenance and the signed archive before running the packaged
bootstrap. Fresh-install intent is completed before starting the autonomous
updater, so an interrupted installer cannot stop a subsequently updated host
when the same command is retried.

`TestSystemdFreshInstallAcceptance` additionally exercises the combined shell
installer on a new isolated Ubuntu 24.04 ARM64 VM, using real Ed25519 manifest
verification, packaged helpers, HTTPS enrollment, systemd and a non-root CPU
monitor. GitHub publication and attestation responses are synthetic fixtures.
It checks that dry run neither installs nor enrolls, the exact requested build
produces telemetry, an identical rerun preserves the monitor PID and updater
identity, and configuration and an unrelated workload remain unchanged.
This test does not replace official provenance or physical GPU canary gates.

The final combined-installer acceptance passed in 3.88 seconds. SHA-256 checks
confirmed the VM executed the final repository installer and bootstrap scripts.
All 19 bootstrap tests, nine managed-installer verification tests, the ordinary
installer suite, embedded-source synchronization check and ShellCheck passed.
The final scripts additionally reject Python import injection, serialize
concurrent bootstrap attempts and preserve later updates after interrupted
setup. The disposable VM is stopped; its fixture disk is retained.

## Earlier update and advanced-installer results

| Boundary | Evidence |
| --- | --- |
| Shared HTTP contract | Byte-identical Go DTOs, OpenAPI, signature golden and hash lock in both repositories; regeneration and verification pass |
| Host transaction | Unit/race tests cover tampering, wrong host/installation, preview downgrade, config changes, revoked authorization, frozen telemetry, GPU domain regression, startup/rollback failures, crash journals, lost reports and exclusive locking |
| Credentials | TLS client tests cover enrollment CSR reuse, machine/purpose/key binding, certificate renewal, short-validity claim rejection, signed request framing and redirect rejection |
| Linux ARM64 | Full Go suite passed as non-root in Go 1.27 Bookworm; real Ubuntu 24.04 systemd acceptance passed in 421.24 seconds |
| Linux AMD64 | Full Go suite, full vet and targeted updater/protocol/signer race tests passed as non-root with Go 1.27.1; real systemd acceptance is incomplete due the emulator issue below |
| Packaging | Installer suite, 19 bootstrap tests, nine managed-installer tests, seven catalog-import tests and Go signer/OpenSSL/importer interoperability passed |
| Yggdrasil and browser | See the sibling [Yggdrasil validation report](../../yggdrasil-updates/docs/agent-updates-validation.md) for full Go, race, 287 frontend tests and 100 Playwright checks |

A final success-only rerun passed in 105.04 seconds after the final host
path-validation and verification-progress changes. Current-source AMD64
updater/protocol/CLI race checks also passed after those changes. Both
disposable VMs are stopped; their fixture disks remain available for inspection.

The real ARM64 acceptance test used the packaged updater executable and units,
a real non-root Leviathan CPU monitor, independently signed fixture releases,
an HTTPS control fixture, and an unrelated `sleep` workload. It verified:

- Bootstrap retained the running monitor PID and its user/configuration.
- The exact requested binary ran with advancing CPU telemetry for 60 seconds.
- A deliberately lost terminal response reconciled without another install.
- A startup-failing candidate restored and verified the previous release.
- `SIGKILL` during verification caused supervisor restart and verified rollback.
- Configuration and unrelated workload PID remained unchanged; 27 signed
  heartbeats kept long operations visible independently of telemetry.

These test signing keys, identities and artifact versions are disposable
fixtures. They do not constitute official GitHub provenance or stable releases.
The integration test is guarded by `LEVIATHAN_UPDATER_DISPOSABLE_HOST=1`, root,
and the explicit `/run/leviathan-updater-disposable-test` marker. It modifies
fixed service/install paths and must run only in a dedicated disposable VM.
The fixture layout and exact assertions are in
[`systemd_integration_test.go`](../internal/updater/systemd_integration_test.go).

## AMD64 emulator limitation

In the isolated OrbStack AMD64 VM, `systemctl daemon-reload` changes a running
monitor's `MainPID` to zero while its original process, exact `/proc/PID/exe`
hash and `NRestarts=0` remain unchanged. The behavior reproduces without the
updater. Bootstrap legitimately reloads systemd, so this environment cannot
complete the process-identity acceptance check. The updater's exact identity
verification was retained. Native AMD64 systemd canary validation is still
required; no emulator workaround is shipped.

## Remaining rollout gates

- Provision the protected CI signing key and distribute its public key through
  an independent trusted channel.
- Publish and verify an official compatible stable release, then import it
  using the repository/workflow/tag/commit provenance policy.
- Validate native AMD64 and physical GPU canaries, including unrelated workloads,
  and perform the real proxy/database/enrollment checks before production enablement.
- Review each host's discovered service/configuration registry and configured
  HTTPS origin. Advanced installations retain their explicit network allowlist;
  normal setup follows DNS without manual CIDRs. Previews require deliberate
  adoption and cannot downgrade.

A failed rollback records `recovery_required` and blocks new jobs. It requires
operator repair; there is no browser bypass. Local chart history is currently
a volatile ring buffer and clears when Leviathan restarts. Existing persistent
files and Yggdrasil durable history are retained; no history migration is added.

The independent Claude Counselor review timed out and was not retried.
Source review, cross-component review and the checks above were completed.
