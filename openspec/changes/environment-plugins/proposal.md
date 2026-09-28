# Environment plugins

## Problem

The monitor's workload schema and host identity joins assume Coder on Kubernetes.
Adding another environment requires edits across the monitor, bridge, and browser.
Builds also run broad policy checks, and completed implementation diaries obscure
the current operating procedures.

## Change

Introduce an exported, versioned protocol for externally supervised plugins and
keep the current host/GPU telemetry model. Move environment-specific identity
resolution behind adapter boundaries. Ship the Kubernetes/Coder adapter and a
non-Coder fixture example to demonstrate the contract. Keep built-in monitoring
usable without plugin configuration.

Integrate the existing Resources/capacity/tooltip work before extracting these
boundaries. Separate compilation, deterministic tests, specialized acceptance,
and release/security checks. Keep the updater's signature and recovery guarantees.

## Limits

This change does not publish a release or deploy to hosts. Plugins are started
and restarted by systemd or Kubernetes; the monitor does not install or execute
arbitrary plugin binaries. New telemetry resource types are outside this release.
