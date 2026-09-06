package attribution

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sort"
	"strings"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

const SchemaVersionV2 = "leviathan.attribution/v2"

// DynamicBinding carries scheduler intent, not a fabricated MIG UUID.
type DynamicBinding struct {
	Ref           string                `json:"ref"`
	ClaimRef      string                `json:"claimRef"`
	WorkloadRef   string                `json:"workloadRef"`
	ParentGPUUUID string                `json:"parentGpuUuid"`
	Profile       string                `json:"profile"`
	State         model.AllocationState `json:"state"`
}

type DocumentV2 struct {
	Document
	Bindings   []DynamicBinding            `json:"bindings"`
	Resolution model.AttributionResolution `json:"resolution"`
}

// OpaqueRef uses the same domain-separated 128-bit SHA-256 references as v1.
func OpaqueRef(prefix, value string) string {
	digest := sha256.Sum256([]byte(prefix + "\x00" + value))
	return prefix + hex.EncodeToString(digest[:16])
}

func ClaimRef(uid string) (string, bool) {
	if !canonicalPodUID.MatchString(uid) {
		return "", false
	}
	return OpaqueRef("claim_", uid), true
}

// AllocationRef's fixed v2 input order is shared by bridge and checkpoint reader.
func AllocationRef(uid, request, driver, pool, device string) string {
	return OpaqueRef("allocation_", strings.Join([]string{uid, request, driver, pool, device}, "\x00"))
}

func CompleteResolution() model.AttributionResolution {
	return model.AttributionResolution{Status: "complete", ReasonCodes: []string{}, Workloads: []model.WorkloadAssignmentResolution{}}
}

func CloneResolution(r model.AttributionResolution) model.AttributionResolution {
	r.ReasonCodes = append([]string{}, r.ReasonCodes...)
	r.Workloads = append([]model.WorkloadAssignmentResolution{}, r.Workloads...)
	for i := range r.Workloads {
		r.Workloads[i].ReasonCodes = append([]string{}, r.Workloads[i].ReasonCodes...)
	}
	return r
}

func AddResolutionIssue(r *model.AttributionResolution, workload, reason string, count int) {
	r.Status = "incomplete"
	r.UnresolvedAssignments += count
	r.ReasonCodes = uniqueReason(r.ReasonCodes, reason)
	if workload == "" {
		return
	}
	for i := range r.Workloads {
		if r.Workloads[i].WorkloadRef == workload {
			r.Workloads[i].UnresolvedAssignments += count
			r.Workloads[i].ReasonCodes = uniqueReason(r.Workloads[i].ReasonCodes, reason)
			return
		}
	}
	r.Workloads = append(r.Workloads, model.WorkloadAssignmentResolution{WorkloadRef: workload, UnresolvedAssignments: count, ReasonCodes: []string{reason}})
	sort.Slice(r.Workloads, func(i, j int) bool { return r.Workloads[i].WorkloadRef < r.Workloads[j].WorkloadRef })
}

func uniqueReason(reasons []string, reason string) []string {
	for _, existing := range reasons {
		if existing == reason {
			return reasons
		}
	}
	reasons = append(reasons, reason)
	sort.Strings(reasons)
	return reasons
}

var resolutionReasons = map[string]bool{
	"legacy_bridge": true, "inventory_incomplete": true, "allocation_unresolved": true,
	"invalid_identity": true, "assignment_conflict": true, "checkpoint_disabled": true,
	"checkpoint_unavailable": true, "checkpoint_invalid": true, "checkpoint_stale": true,
	"preparation_pending": true, "binding_mismatch": true, "topology_unavailable": true,
	"topology_mismatch": true, "binding_replaced": true, "source_stale": true,
}

func (d DocumentV2) Validate() error {
	if d.SchemaVersion != SchemaVersionV2 {
		return errors.New("unsupported attribution v2 schema")
	}
	legacy := d.Document
	legacy.SchemaVersion = SchemaVersion
	if err := legacy.Validate(); err != nil {
		return err
	}
	if len(d.Bindings)+len(d.Assignments) > MaxAssignments {
		return errors.New("too many allocation bindings")
	}
	workloads := make(map[string]bool)
	for _, w := range d.Workloads {
		workloads[w.Ref] = true
	}
	seen := make(map[string]bool)
	for _, b := range d.Bindings {
		if !validOpaqueRef(b.Ref, "allocation_") || !validOpaqueRef(b.ClaimRef, "claim_") || !workloads[b.WorkloadRef] ||
			!strings.HasPrefix(b.ParentGPUUUID, "GPU-") || !validDisplayString(b.ParentGPUUUID, 128, false) ||
			!validDisplayString(b.Profile, 128, false) ||
			(b.State != model.AllocationStateAllocated && b.State != model.AllocationStateReserved) || seen[b.Ref] {
			return errors.New("invalid dynamic allocation binding")
		}
		seen[b.Ref] = true
	}
	r := d.Resolution
	if (r.Status != "complete" && r.Status != "incomplete" && r.Status != "unknown") || r.UnresolvedAssignments < 0 ||
		r.UnresolvedAssignments > MaxAssignments || len(r.Workloads) > MaxWorkloads ||
		(r.Status == "complete" && (r.UnresolvedAssignments != 0 || len(r.ReasonCodes) != 0 || len(r.Workloads) != 0)) {
		return errors.New("invalid attribution completeness")
	}
	for _, reason := range r.ReasonCodes {
		if !resolutionReasons[reason] {
			return errors.New("invalid resolution reason")
		}
	}
	seen = make(map[string]bool)
	total := 0
	for _, w := range r.Workloads {
		if !workloads[w.WorkloadRef] || seen[w.WorkloadRef] || w.UnresolvedAssignments < 0 {
			return errors.New("invalid workload resolution")
		}
		seen[w.WorkloadRef] = true
		total += w.UnresolvedAssignments
		for _, reason := range w.ReasonCodes {
			if !resolutionReasons[reason] {
				return errors.New("invalid workload resolution reason")
			}
		}
	}
	if total > r.UnresolvedAssignments {
		return errors.New("resolution count mismatch")
	}
	return nil
}
