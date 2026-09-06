// Package workload collects owner-scoped host resources independently of GPU
// telemetry. Its Pod handoff is private and never included in Uplink v1.
package workload

import (
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

const (
	SchemaVersion    = "leviathan.workloads/v1"
	MaxDocumentBytes = 1 << 20
	MaxOwners        = 128
	MaxWorkspaces    = 1024
	MaxPods          = 4096
	SamplingInterval = 2 * time.Second
)

type Owner struct {
	Ref        string                      `json:"ref"`
	Name       string                      `json:"name"`
	Platform   model.WorkloadPlatform      `json:"platform"`
	Workspaces []model.WorkloadAttribution `json:"workspaces"`
}

// Pod contains only a hashed scope and its sanitized ownership join. Neither
// raw UIDs nor paths, Pod specs, container arguments, or environment enter it.
type Pod struct {
	ScopeRef    string `json:"scopeRef"`
	OwnerRef    string `json:"ownerRef"`
	WorkloadRef string `json:"workloadRef"`
}

type Document struct {
	SchemaVersion string                        `json:"schemaVersion"`
	GeneratedAt   time.Time                     `json:"generatedAt"`
	ObservedAt    time.Time                     `json:"observedAt"`
	Status        model.WorkloadTelemetryStatus `json:"status"`
	Message       string                        `json:"message,omitempty"`
	Owners        []Owner                       `json:"owners"`
	Pods          []Pod                         `json:"pods"`
}

var opaque = regexp.MustCompile(`^(owner_|workspace_|scope_)[0-9a-f]{32}$`)

func validRef(ref, prefix string) bool {
	return strings.HasPrefix(ref, prefix) && opaque.MatchString(ref)
}

func validDisplay(value string, limit int) bool {
	if value == "" || len(value) > limit || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}

func (d Document) Validate() error {
	if d.SchemaVersion != SchemaVersion || d.GeneratedAt.IsZero() || d.ObservedAt.IsZero() || d.ObservedAt.After(d.GeneratedAt.Add(time.Second)) {
		return errors.New("invalid workload document envelope")
	}
	switch d.Status {
	case model.WorkloadTelemetryAvailable, model.WorkloadTelemetryPartial, model.WorkloadTelemetryUnavailable, model.WorkloadTelemetryStale:
	default:
		return errors.New("invalid workload inventory status")
	}
	if len(d.Owners) > MaxOwners || len(d.Pods) > MaxPods || (d.Message != "" && !validDisplay(d.Message, 512)) {
		return errors.New("workload inventory exceeds bounds")
	}
	owners := map[string]bool{}
	workspaces := map[string]string{}
	scopes := map[string]bool{}
	for _, owner := range d.Owners {
		if !validRef(owner.Ref, "owner_") || owners[owner.Ref] || !validDisplay(owner.Name, 128) || owner.Platform != model.WorkloadPlatformCoder || len(owner.Workspaces) == 0 {
			return errors.New("invalid or duplicate workload owner")
		}
		owners[owner.Ref] = true
		for _, w := range owner.Workspaces {
			if !validRef(w.Ref, "workspace_") || workspaces[w.Ref] != "" || w.Platform != owner.Platform || w.Kind != model.WorkloadKindWorkspace || w.OwnerName != owner.Name || !validDisplay(w.Name, 253) {
				return errors.New("ambiguous workspace ownership")
			}
			workspaces[w.Ref] = owner.Ref
		}
	}
	if len(workspaces) > MaxWorkspaces {
		return errors.New("too many workspaces")
	}
	for _, pod := range d.Pods {
		if !validRef(pod.ScopeRef, "scope_") || scopes[pod.ScopeRef] || !owners[pod.OwnerRef] || workspaces[pod.WorkloadRef] != pod.OwnerRef {
			return errors.New("invalid or ambiguous Pod ownership")
		}
		scopes[pod.ScopeRef] = true
	}
	return nil
}
