package kubernetesbridge

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/attribution"
	"github.com/intellisys-stevens/leviathan/internal/model"
	corev1 "k8s.io/api/core/v1"
	resourcev1 "k8s.io/api/resource/v1"
)

func dynamicDevice(name string) resourcev1.Device {
	d := device(name, "", "mig")
	delete(d.Attributes, "uuid")
	parent, profile := "GPU-parent", "1g.24gb"
	d.Attributes["parentUUID"] = resourcev1.DeviceAttribute{StringValue: &parent}
	d.Attributes["profile"] = resourcev1.DeviceAttribute{StringValue: &profile}
	return d
}
func dynamicInventoryFixture() (*resourcev1.ResourceClaim, []*resourcev1.ResourceSlice) {
	c := resourceClaim("private-workspace-id", "workspace", "owner", true, allocation("gpu.nvidia.com", "pool", "full"), allocation("gpu.nvidia.com", "pool", "dynamic-a"), allocation("gpu.nvidia.com", "pool", "dynamic-b"))
	c.UID = "11111111-2222-3333-4444-555555555555"
	return c, []*resourcev1.ResourceSlice{resourceSlice("node", "gpu.nvidia.com", "pool", 2, 1, device("full", "GPU-full", "gpu"), dynamicDevice("dynamic-a"), dynamicDevice("dynamic-b"))}
}
func validateInventoryV2(t *testing.T, inv InventoryV2) attribution.DocumentV2 {
	t.Helper()
	now := time.Now().UTC()
	s := NewState("test", "node", now)
	s.UpdateInventories(nil, nil, nil, BuildStats{}, inv, now)
	d := s.DocumentV2(now)
	if err := d.Validate(); err != nil {
		t.Fatalf("invalid v2: %v %+v", err, d)
	}
	if s.Document(now).SchemaVersion != attribution.SchemaVersion {
		t.Fatal("v1 compatibility changed")
	}
	return d
}
func TestV2PreservesDynamicMIGWithoutUUIDAndLegacyOutput(t *testing.T) {
	c, s := dynamicInventoryFixture()
	w, a, p, stats := BuildInventory([]*resourcev1.ResourceClaim{c}, s, "node", "gpu.nvidia.com")
	if len(w) != 1 || len(a) != 1 || stats.UnresolvedDevices != 2 {
		t.Fatal("legacy behavior changed")
	}
	inv := BuildInventoryV2([]*resourcev1.ResourceClaim{c}, s, "node", "gpu.nvidia.com")
	if len(inv.Assignments) != 1 || len(inv.Bindings) != 2 || len(inv.Workloads) != 1 || len(inv.ProcessScopes) != len(p) || inv.Resolution.Status != "complete" {
		t.Fatal(inv)
	}
	d := validateInventoryV2(t, inv)
	data, _ := json.Marshal(d)
	for _, private := range []string{string(c.UID), "private-workspace-id", "dynamic-a", "dynamic-b", c.Name} {
		if strings.Contains(string(data), private) {
			t.Fatal("raw identity leaked")
		}
	}
	for _, b := range inv.Bindings {
		if b.ParentGPUUUID != "GPU-parent" || b.Profile != "1g.24gb" || b.State != model.AllocationStateAllocated {
			t.Fatal(b)
		}
	}
	c.Status.Allocation.Devices.Results = c.Status.Allocation.Devices.Results[1:]
	inv = BuildInventoryV2([]*resourcev1.ResourceClaim{c}, s, "node", "gpu.nvidia.com")
	if len(inv.Workloads) != 1 || len(inv.Bindings) != 2 || len(inv.Assignments) != 0 {
		t.Fatal("dynamic-only workspace dropped", inv)
	}
}
func TestV2IncompleteLatestPoolAndUnresolvedWorkloads(t *testing.T) {
	for _, name := range []string{"missing slice", "new partial generation", "parent uuid", "unknown profile", "invalid claim uid", "invalid labels", "duplicate device", "owner conflict"} {
		t.Run(name, func(t *testing.T) {
			c, s := dynamicInventoryFixture()
			claims := []*resourcev1.ResourceClaim{c}
			switch name {
			case "missing slice":
				s = nil
			case "new partial generation":
				s = append(s, resourceSlice("node", "gpu.nvidia.com", "pool", 3, 2, dynamicDevice("dynamic-a")))
			case "parent uuid":
				v := "GPU-parent"
				s[0].Spec.Devices[1].Attributes["uuid"] = resourcev1.DeviceAttribute{StringValue: &v}
			case "unknown profile":
				delete(s[0].Spec.Devices[1].Attributes, "profile")
			case "invalid claim uid":
				c.UID = "not-a-uid"
			case "invalid labels":
				c.Labels[LabelCoderUsername] = "bad\nlabel"
			case "duplicate device":
				s[0].Spec.Devices = append(s[0].Spec.Devices, s[0].Spec.Devices[1])
			case "owner conflict":
				other := c.DeepCopy()
				other.Labels[LabelCoderUsername] = "conflicting-owner"
				claims = append(claims, other)
			}
			inv := BuildInventoryV2(claims, s, "node", "gpu.nvidia.com")
			if inv.Resolution.Status != "incomplete" {
				t.Fatal("unsafe completeness", inv)
			}
			validateInventoryV2(t, inv)
			if name == "missing slice" && (len(inv.Workloads) != 1 || inv.Resolution.UnresolvedAssignments != 3) {
				t.Fatal("missing allocations dropped", inv)
			}
		})
	}
}
func TestV2ForeignRemoteStaticAndReservations(t *testing.T) {
	c, s := dynamicInventoryFixture()
	c.Status.ReservedFor = nil
	inv := BuildInventoryV2([]*resourcev1.ResourceClaim{c}, s, "node", "gpu.nvidia.com")
	for _, b := range inv.Bindings {
		if b.State != model.AllocationStateReserved {
			t.Fatal(b)
		}
	}
	remote := c.DeepCopy()
	remote.Status.Allocation.NodeSelector = &corev1.NodeSelector{NodeSelectorTerms: []corev1.NodeSelectorTerm{{MatchFields: []corev1.NodeSelectorRequirement{{Key: "metadata.name", Operator: corev1.NodeSelectorOpIn, Values: []string{"other-node"}}}}}}
	foreign := c.DeepCopy()
	for i := range foreign.Status.Allocation.Devices.Results {
		foreign.Status.Allocation.Devices.Results[i].Driver = "another.example"
	}
	inv = BuildInventoryV2([]*resourcev1.ResourceClaim{remote, foreign}, s, "node", "gpu.nvidia.com")
	if inv.Resolution.Status != "complete" || len(inv.Workloads) != 0 {
		t.Fatal(inv)
	}
	s[0].Spec.Devices[1] = device("dynamic-a", "MIG-static-a", "mig")
	s[0].Spec.Devices[2] = device("dynamic-b", "MIG-static-b", "mig")
	inv = BuildInventoryV2([]*resourcev1.ResourceClaim{c, c}, s, "node", "gpu.nvidia.com")
	if inv.Resolution.Status != "complete" || len(inv.Assignments) != 3 || len(inv.Bindings) != 0 {
		t.Fatal(inv)
	}
	validateInventoryV2(t, inv)
}
