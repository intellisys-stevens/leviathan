package attribution

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

func TestDocumentValidation(t *testing.T) {
	document := validDocument(time.Unix(1_700_000_000, 0).UTC())
	if err := document.Validate(); err != nil {
		t.Fatalf("valid document: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*Document)
	}{
		{name: "schema", mutate: func(value *Document) { value.SchemaVersion = "leviathan.attribution/v2" }},
		{name: "raw-workspace-id", mutate: func(value *Document) { value.Workloads[0].Ref = "workspace-upstream-id" }},
		{name: "control-character", mutate: func(value *Document) { value.Workloads[0].OwnerName = "owner\nname" }},
		{name: "unknown-workload", mutate: func(value *Document) { value.Assignments[0].WorkloadRef = "workspace_00000000000000000000000000000000" }},
		{name: "wrong-uuid-kind", mutate: func(value *Document) { value.Assignments[0].EntityUUID = "GPU-synthetic-0001" }},
		{name: "duplicate-assignment", mutate: func(value *Document) { value.Assignments = append(value.Assignments, value.Assignments[0]) }},
		{name: "raw-process-scope", mutate: func(value *Document) { value.ProcessScopes[0].ScopeRef = "pod-upstream-uid" }},
		{name: "unknown-scope-workload", mutate: func(value *Document) {
			value.ProcessScopes[0].WorkloadRef = "workspace_00000000000000000000000000000000"
		}},
		{name: "duplicate-process-scope", mutate: func(value *Document) { value.ProcessScopes = append(value.ProcessScopes, value.ProcessScopes[0]) }},
		{name: "ambiguous-process-scope", mutate: func(value *Document) {
			value.Workloads = append(value.Workloads, model.WorkloadAttribution{
				Ref: "workspace_44444444444444444444444444444444", Platform: model.WorkloadPlatformCoder,
				Kind: model.WorkloadKindWorkspace, Name: "other-workspace", OwnerName: "other-owner",
			})
			value.ProcessScopes = append(value.ProcessScopes, ProcessScope{ScopeRef: value.ProcessScopes[0].ScopeRef, WorkloadRef: value.Workloads[1].Ref})
		}},
		{name: "workload-kind", mutate: func(value *Document) { value.Workloads[0].Kind = "job" }},
		{name: "zero-revision", mutate: func(value *Document) { value.Revision = 0 }},
		{name: "available-without-inventory", mutate: func(value *Document) { value.Status.HasValidInventory = false }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := document
			candidate.Workloads = append([]model.WorkloadAttribution(nil), document.Workloads...)
			candidate.Assignments = append([]model.ResourceAssignment(nil), document.Assignments...)
			candidate.ProcessScopes = append([]ProcessScope(nil), document.ProcessScopes...)
			test.mutate(&candidate)
			if err := candidate.Validate(); err == nil {
				t.Fatal("invalid document was accepted")
			}
		})
	}
}

func TestScopeRefForPodUIDCanonicalizesSystemdUID(t *testing.T) {
	dashed, ok := ScopeRefForPodUID("00000000-0000-4000-8000-000000000001")
	if !ok {
		t.Fatal("valid Pod UID was rejected")
	}
	underscored, ok := ScopeRefForPodUID("00000000_0000_4000_8000_000000000001")
	if !ok || underscored != dashed || !validOpaqueRef(dashed, "scope_") {
		t.Fatalf("scope refs dashed=%q underscored=%q valid=%v", dashed, underscored, ok)
	}
	for _, invalid := range []string{"", "synthetic-pod", "00000000-0000-0000-0000-000000000001-extra"} {
		if value, accepted := ScopeRefForPodUID(invalid); accepted || value != "" {
			t.Fatalf("invalid Pod UID %q produced %q", invalid, value)
		}
	}
}

func TestDocumentAcceptsV1PayloadWithoutProcessScopes(t *testing.T) {
	document := validDocument(time.Unix(1_700_000_000, 0).UTC())
	payload, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatal(err)
	}
	delete(fields, "processScopes")
	payload, err = json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Document
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if err := decoded.Validate(); err != nil {
		t.Fatalf("backward-compatible v1 payload was rejected: %v", err)
	}
}

func TestDocumentBoundsProcessScopes(t *testing.T) {
	document := validDocument(time.Unix(1_700_000_000, 0).UTC())
	document.ProcessScopes = make([]ProcessScope, MaxProcessScopes+1)
	for index := range document.ProcessScopes {
		document.ProcessScopes[index] = ProcessScope{
			ScopeRef: fmt.Sprintf("scope_%032x", index), WorkloadRef: document.Workloads[0].Ref,
		}
	}
	if err := document.Validate(); err == nil {
		t.Fatal("oversized process-scope inventory was accepted")
	}
}

func validDocument(at time.Time) Document {
	return Document{
		SchemaVersion: SchemaVersion, BridgeVersion: "test",
		InstanceID: "instance_11111111111111111111111111111111", Revision: 7,
		GeneratedAt: at, SourceObservedAt: at, NodeRef: "node_22222222222222222222222222222222",
		Status: SourceStatus{State: SourceAvailable, HasValidInventory: true},
		Workloads: []model.WorkloadAttribution{{
			Ref: "workspace_33333333333333333333333333333333", Platform: model.WorkloadPlatformCoder,
			Kind: model.WorkloadKindWorkspace, Name: "synthetic-workspace", OwnerName: "synthetic-owner",
		}},
		Assignments: []model.ResourceAssignment{{
			WorkloadRef: "workspace_33333333333333333333333333333333",
			EntityType:  model.AllocationEntityComputeInstance, EntityUUID: "MIG-synthetic-0001", State: model.AllocationStateReserved,
		}},
		ProcessScopes: []ProcessScope{{
			ScopeRef: "scope_44444444444444444444444444444444", WorkloadRef: "workspace_33333333333333333333333333333333",
		}},
	}
}
