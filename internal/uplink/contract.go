// Package uplink projects Leviathan's machine-local telemetry onto the
// deliberately smaller, generated uplink-v1 contract and sends the latest
// observation to a trusted Yggdrasil ingress.
package uplink

const EndpointPath = "/api/uplink/v1/snapshots"
