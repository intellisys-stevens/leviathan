# Managed update validation

The feature is implemented in fresh `feat/per-host-agent-updates` worktrees.
Yggdrasil starts from main `7eb18736d39a57da2070e0702fd9b9322213fa77`;
Leviathan starts from main `b524433b6b5596892b9b7f366791692af31229f3`.
The feature remains disabled by default. These results are implementation and
disposable-host evidence, not a production release or deployment approval.

## Results

| Boundary | Evidence |
| --- | --- |
| Shared HTTP contract | Byte-identical Go DTOs, OpenAPI, signature golden and hash lock in both repositories; regeneration and verification pass |
| Host transaction | Unit/race tests cover tampering, wrong host/installation, preview downgrade, config changes, revoked authorization, frozen telemetry, GPU domain regression, startup/rollback failures, crash journals, lost reports and exclusive locking |
| Credentials | TLS client tests cover enrollment CSR reuse, machine/purpose/key binding, certificate renewal, short-validity claim rejection, signed request framing and redirect rejection |
| Linux ARM64 | Full Go suite passed as non-root in Go 1.27 Bookworm; real Ubuntu 24.04 systemd acceptance passed in 421.24 seconds |
| Linux AMD64 | Full Go suite, full vet and targeted updater/protocol/signer race tests passed as non-root with Go 1.27.1; real systemd acceptance is incomplete due the emulator issue below |
| Packaging | Installer suite, seven bootstrap tests, seven catalog-import tests and Go signer/OpenSSL/importer interoperability passed |
| Yggdrasil and browser | See the sibling [Yggdrasil validation report](../../yggdrasil-updates/docs/agent-updates-validation.md) for full Go, race, frontend and 88 Playwright checks |

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
- Review every host's explicit config/environment registry, fixed service and
  egress allowlist. Previews require deliberate adoption and cannot downgrade.

A failed rollback records `recovery_required` and blocks new jobs. It requires
operator repair; there is no browser bypass. Local chart history is currently
a volatile ring buffer and clears when Leviathan restarts. Existing persistent
files and Yggdrasil durable history are retained; no history migration is added.

The independent Claude Counselor review timed out and was not retried.
Source review, cross-component review and the checks above were completed.
