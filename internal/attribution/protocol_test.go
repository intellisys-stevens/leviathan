package attribution

import (
	"testing"
	"time"

	"github.com/intellisys-stevens/miglens/internal/model"
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
		{name: "schema", mutate: func(value *Document) { value.SchemaVersion = "miglens.attribution/v2" }},
		{name: "raw-workspace-id", mutate: func(value *Document) { value.Workloads[0].Ref = "workspace-upstream-id" }},
		{name: "control-character", mutate: func(value *Document) { value.Workloads[0].OwnerName = "owner\nname" }},
		{name: "unknown-workload", mutate: func(value *Document) { value.Assignments[0].WorkloadRef = "workspace_00000000000000000000000000000000" }},
		{name: "wrong-uuid-kind", mutate: func(value *Document) { value.Assignments[0].EntityUUID = "GPU-synthetic-0001" }},
		{name: "duplicate-assignment", mutate: func(value *Document) { value.Assignments = append(value.Assignments, value.Assignments[0]) }},
		{name: "workload-kind", mutate: func(value *Document) { value.Workloads[0].Kind = "job" }},
		{name: "zero-revision", mutate: func(value *Document) { value.Revision = 0 }},
		{name: "available-without-inventory", mutate: func(value *Document) { value.Status.HasValidInventory = false }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := document
			candidate.Workloads = append([]model.WorkloadAttribution(nil), document.Workloads...)
			candidate.Assignments = append([]model.ResourceAssignment(nil), document.Assignments...)
			test.mutate(&candidate)
			if err := candidate.Validate(); err == nil {
				t.Fatal("invalid document was accepted")
			}
		})
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
	}
}
