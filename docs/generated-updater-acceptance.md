# Generated installer and reboot acceptance

This is a test protocol, not permission to enroll a production node, publish a
release, or enable updates globally. Use only an explicitly approved disposable
Linux host. Preserve existing data and workloads. All fixture versions and signing
keys are test-only; product release metadata is unchanged.

## Sustained telemetry and recovery

Generated recovery is a bounded oneshot that remains active after completion and
runs before both the monitor and updater at boot. The exclusive transaction lock
and fail-closed offline recovery remain in place.

Setup, later updates, and rollback use the same observer-local healthy window.
Sampling cadence comes from the existing `GET /api/v1/settings` endpoint and must
be between 250 ms and 60 s. Samples must stay within `max(5 s, 3 * cadence)`, remain
monotonic, and advance at least twice during at least 60 seconds of health. A
stall, missing required domain, failed probe, future timestamp over five seconds,
clock regression, or cadence change cannot inherit the previous healthy window.
The overall 150-second verification deadline includes probe requests. Cadence is
observer-only and is not added to the persisted journal or shared wire protocol.

## Native CI

The `automatic-setup-systemd` matrix runs on native AMD64 and ARM64 systemd VMs.
After real automatic installation and interrupted-setup resume, it now performs:

1. A signed update from fixture 0.4.1 to the real CLI built as fixture 0.4.2.
2. A signed, metadata-valid fixture 0.4.3 whose `serve` command deliberately fails,
   followed by a fully verified rollback to the previous executable.
3. `SIGKILL` during verification of fixture 0.4.4, followed by supervisor recovery
   and fully verified rollback.

Checks include the actual running executable digest, required CPU/GPU domains,
unchanged authorized configuration, recovery-unit lifetime, and an unrelated
sentinel workload's PID. The receipt is retained with the exact-source native
fixture package, checksums, and `SOURCE_COMMIT`. Native fixtures must require no
newer than glibc 2.34; architecture alone is not evidence of compatibility.

## Separate whole-machine reboot gate

Whole-machine reboots are an additional operator-controlled gate, not simulated
by restarting a service and not performed automatically by the Go tests.

On an identity-checked host with no existing Leviathan installation, run the
retained `automatic-setup.test` with `LEVIATHAN_UPDATER_DISPOSABLE_HOST=1`, the
existing `/run/leviathan-updater-disposable-test` marker, and
`LEVIATHAN_UPDATER_REBOOT_HOST_UUID` set to the independently verified exact Nova
UUID. Select `TestSystemdAutomaticSetupAcceptance` and allow 720 seconds. The
fixture refuses mismatched identities and existing fixture configuration. Keep
at least 8 GiB free; never clean unrelated host data to make room.

After the native sequence passes, that opt-in prepares a loopback-only persistent
test control service at the original fixture URL. The TLS certificate, replay
ledger, jobs and outcomes survive reboot. No private credential or ticket is
printed; do not publish these local fixture files or machine identifiers.

1. Independently recheck host identity/workloads, then reboot the whole machine.
   Reconnect normally and run `TestSystemdRebootHealthyAcceptance` with the same
   exact-host environment. It requires a new boot ID, boot ordering evidence and
   another full healthy window.
2. Run `TestSystemdRebootPrepareInterruptedUpdate`. It queues one fixed signed
   test candidate, waits for `verifying`, kills and stops only the test updater,
   and retains a witness. It does **not** reboot the host.
3. Recheck identity/workloads again, reboot, reconnect, and run
   `TestSystemdRebootInterruptedAcceptance`. It requires another new boot ID,
   recovery before monitor startup, the previous exact executable/configuration,
   required telemetry domains, and the verified rollback outcome for that job.

Retain the three public receipts under `/var/lib/leviathan-merge-acceptance`
privately with the matching source and artifact hashes. Stop and disable all
test-created services after acceptance, and withdraw only the fixture CA from
system trust while retaining a copy. Do not alter existing desktop containers,
production services, SSH keys, or system toolchains. A vGPU test must not be
reported as bare-metal GPU acceptance.
