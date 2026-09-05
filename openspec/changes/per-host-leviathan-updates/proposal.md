# Per-host Leviathan updates

## Why

Operators need a manual way to update one host's Leviathan installation from
Yggdrasil. The transaction must survive the monitor stopping, a failed new
binary, and control-plane outages. Existing telemetry or viewer access must
not become permission to change a host executable.

## What changes

- Add a default-off, versioned update control plane in Yggdrasil, with an
  approved stable release catalog, exact-host delegations, durable jobs and
  metadata-only audit records.
- Add a separate root-owned Leviathan updater, enrolled for one exact machine
  and one locally registered monitoring service. It verifies, stages, installs,
  checks health and restores the previous release when necessary.
- Add signed release manifests and official GitHub provenance verification.
  Release signing occurs outside Yggdrasil; only public verification keys reach
  the control plane and host.
- Add update status, manual controls, maintainer administration and deliberate
  one-time enrollment to existing machine detail and live views. Include an
  updater-only host chooser for delegated maintainers without inventory ownership.
- Add explicit local bootstrap and boot-time recovery without enabling managed
  updates through the normal installer.

## Scope and compatibility

Only a newer compatible stable Leviathan release may be selected. Preview
adoption requires a local operator's explicit choice and never permits an
older stable release to replace the current preview. Updater self-updates,
Yggdrasil updates, fleet-wide rollout, arbitrary commands, remote hooks and
configuration/state migrations are outside this change.

The update protocol is separate from telemetry-only Uplink and viewer
connections. Preserve existing accounting schema 19 and legacy viewer
identities through additive updater tables and certificate-purpose fields.
Configuration and state compatibility profiles must match exactly.

## Delivery boundary

The matching change documents in the Yggdrasil and Leviathan feature worktrees
describe one cross-repository capability. Source implementation and local
checks are separate from deployment readiness. Test-host bootstrap,
release-key provisioning, official stable publication, enrollment, failure
injection and production enablement remain explicit gates in `tasks.md`.
