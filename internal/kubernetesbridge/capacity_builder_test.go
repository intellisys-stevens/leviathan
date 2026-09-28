package kubernetesbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/gpucapacity"
	corev1 "k8s.io/api/core/v1"
	resourcev1 "k8s.io/api/resource/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
)

func capacityDevice(name, kind, memory, profile string, counters ...string) resourcev1.Device {
	d := device(name, "GPU-parent", kind)
	d.Attributes["productName"] = resourcev1.DeviceAttribute{StringValue: ptr.To("NVIDIA Test 96GB")}
	d.Capacity = map[resourcev1.QualifiedName]resourcev1.DeviceCapacity{"memory": {Value: resource.MustParse(memory)}}
	if kind == "mig" {
		delete(d.Attributes, "uuid")
		d.Attributes["profile"] = resourcev1.DeviceAttribute{StringValue: &profile}
		d.Attributes["parentUUID"] = resourcev1.DeviceAttribute{StringValue: ptr.To("GPU-parent")}
	}
	if len(counters) > 0 {
		used := map[string]resourcev1.Counter{}
		for _, name := range counters {
			used[name] = resourcev1.Counter{Value: resource.MustParse("1")}
		}
		d.ConsumesCounters = []resourcev1.DeviceCounterConsumption{{CounterSet: "gpu-0", Counters: used}}
	}
	return d
}

func capacityFixture() CapacityInput {
	slice := resourceSlice("node", "gpu.nvidia.com", "private-local-pool", 1, 2,
		capacityDevice("private-native", "gpu", "96Gi", "", "m0", "m1"),
		capacityDevice("private-mig-full", "mig", "96Gi", "4g.96gb", "m0", "m1"),
		capacityDevice("private-mig-half-a", "mig", "48Gi", "2g.48gb", "m0"),
		capacityDevice("private-mig-half-b", "mig", "48Gi", "2g.48gb", "m1"),
		capacityDevice("private-mig-overlap", "mig", "48Gi", "2g.48gb", "m0"))
	counters := resourceSlice("node", "gpu.nvidia.com", "private-local-pool", 1, 2)
	counters.Name += "-counters"
	counters.Spec.SharedCounters = []resourcev1.CounterSet{{Name: "gpu-0", Counters: map[string]resourcev1.Counter{"m0": {Value: resource.MustParse("1")}, "m1": {Value: resource.MustParse("1")}}}}
	classes := []*resourcev1.DeviceClass{}
	for _, kind := range []string{"gpu", "mig"} {
		classes = append(classes, &resourcev1.DeviceClass{ObjectMeta: metav1.ObjectMeta{Name: kind + ".nvidia.com"}, Spec: resourcev1.DeviceClassSpec{Selectors: []resourcev1.DeviceSelector{{CEL: &resourcev1.CELDeviceSelector{Expression: `device.driver == "gpu.nvidia.com" && device.attributes["gpu.nvidia.com"].type == "` + kind + `"`}}}}})
	}
	return CapacityInput{Node: &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node"}}, Driver: "gpu.nvidia.com", Slices: []*resourcev1.ResourceSlice{slice, counters}, Classes: classes}
}

func capacityBuild(t *testing.T, input CapacityInput) gpucapacity.Document {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	d := BuildCapacity(ctx, input, time.Now().UTC())
	if err := d.Validate(); err != nil {
		t.Fatalf("invalid document: %v %+v", err, d)
	}
	return d
}

func expectCapacity(t *testing.T, d gpucapacity.Document, counts ...int64) {
	t.Helper()
	if d.Status != "available" || len(d.Rows) != len(counts) {
		t.Fatalf("capacity = %+v", d)
	}
	for i, count := range counts {
		if d.Rows[i].Available == nil || *d.Rows[i].Available != count {
			t.Fatalf("row %d = %+v, want %d", i, d.Rows[i], count)
		}
	}
}

func TestCapacityHonorsNativeMIGAndOverlappingPartitionCounters(t *testing.T) {
	input := capacityFixture()
	expectCapacity(t, capacityBuild(t, input), 1, 1, 2)
	// A non-Coder allocated claim in another namespace, even without a Pod
	// consumer, occupies the same baseline for every profile alternative.
	claim := &resourcev1.ResourceClaim{ObjectMeta: metav1.ObjectMeta{Name: "private-reservation", Namespace: "foreign-team"}, Status: resourcev1.ResourceClaimStatus{Allocation: &resourcev1.AllocationResult{Devices: resourcev1.DeviceAllocationResult{Results: []resourcev1.DeviceRequestAllocationResult{allocation(input.Driver, "private-local-pool", "private-mig-half-a")}}}}}
	input.Claims = []*resourcev1.ResourceClaim{claim}
	d := capacityBuild(t, input)
	expectCapacity(t, d, 0, 0, 1)
	encoded, _ := json.Marshal(d)
	for _, private := range []string{"private-", "foreign-team", "GPU-parent", "gpu-0", "node"} {
		if strings.Contains(string(encoded), private) {
			t.Fatalf("private source value leaked: %s", private)
		}
	}
	input.Claims = nil
	expectCapacity(t, capacityBuild(t, input), 1, 1, 2)
}

func TestCapacityStaticMIGAndHostIsolation(t *testing.T) {
	input := capacityFixture()
	a, b := capacityDevice("a", "mig", "48Gi", "2g.48gb"), capacityDevice("b", "mig", "48Gi", "2g.48gb")
	a.Attributes["uuid"], b.Attributes["uuid"] = resourcev1.DeviceAttribute{StringValue: ptr.To("MIG-a")}, resourcev1.DeviceAttribute{StringValue: ptr.To("MIG-b")}
	input.Slices = []*resourcev1.ResourceSlice{resourceSlice("node", input.Driver, "local", 1, 1, a, b), resourceSlice("other-node", input.Driver, "remote", 1, 1, capacityDevice("remote", "gpu", "96Gi", ""))}
	input.Claims = []*resourcev1.ResourceClaim{{Status: resourcev1.ResourceClaimStatus{Allocation: &resourcev1.AllocationResult{Devices: resourcev1.DeviceAllocationResult{Results: []resourcev1.DeviceRequestAllocationResult{allocation(input.Driver, "remote", "remote")}}}}}}
	expectCapacity(t, capacityBuild(t, input), 2)
	input.Node.Name = "other-node"
	expectCapacity(t, capacityBuild(t, input), 0)
}

func TestCapacityUnknownNeverBecomesZero(t *testing.T) {
	for _, scenario := range []string{"incomplete generation", "inconsistent count", "missing class", "unresolved allocation", "missing counter", "sharing", "compatibility groups", "vfio", "opaque class", "unmodeled overlap", "dynamic without counters", "missing profile"} {
		t.Run(scenario, func(t *testing.T) {
			input := capacityFixture()
			switch scenario {
			case "incomplete generation":
				newer := input.Slices[0].DeepCopy()
				newer.Name += "-new"
				newer.Spec.Pool.Generation++
				input.Slices = append(input.Slices, newer)
			case "inconsistent count":
				input.Slices[1].Spec.Pool.ResourceSliceCount = 3
			case "missing class":
				input.Classes = nil
			case "unresolved allocation":
				input.Claims = []*resourcev1.ResourceClaim{{Status: resourcev1.ResourceClaimStatus{Allocation: &resourcev1.AllocationResult{Devices: resourcev1.DeviceAllocationResult{Results: []resourcev1.DeviceRequestAllocationResult{allocation(input.Driver, "private-local-pool", "missing")}}}}}}
			case "missing counter":
				delete(input.Slices[1].Spec.SharedCounters[0].Counters, "m0")
			case "sharing":
				input.Slices[0].Spec.Devices[0].AllowMultipleAllocations = ptr.To(true)
			case "compatibility groups":
				input.Slices[0].Spec.Devices[0].ConsumesCounters[0].CompatibilityGroups = []string{"unsupported"}
			case "vfio":
				input.Slices[0].Spec.Devices[0].Attributes["type"] = resourcev1.DeviceAttribute{StringValue: ptr.To("vfio")}
			case "opaque class":
				for _, class := range input.Classes {
					class.Spec.Config = []resourcev1.DeviceClassConfiguration{{}}
				}
			case "unmodeled overlap":
				input.Slices[0].Spec.Devices[0].ConsumesCounters = nil
			case "dynamic without counters":
				input.Slices[0].Spec.Devices[1].ConsumesCounters = nil
			case "missing profile":
				for i := range input.Slices[0].Spec.Devices {
					delete(input.Slices[0].Spec.Devices[i].Attributes, "profile")
				}
				input.Classes = input.Classes[1:]
			}
			d := capacityBuild(t, input)
			if d.Status == "available" {
				t.Fatalf("uncertain source reported available: %+v", d)
			}
			for _, row := range d.Rows {
				if row.Available != nil {
					t.Fatalf("uncertain count: %+v", row)
				}
			}
		})
	}
}

func TestCapacityEmptyCompletePoolAndMissingDRA(t *testing.T) {
	input := capacityFixture()
	input.Slices = []*resourcev1.ResourceSlice{resourceSlice("node", input.Driver, "empty", 1, 1)}
	expectCapacity(t, capacityBuild(t, input))
	input.Slices = nil
	if d := capacityBuild(t, input); d.Status != "unavailable" || len(d.Rows) != 0 {
		t.Fatal(d)
	}
}

func TestCapacityContextCancellationReturnsUnknown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	d := BuildCapacity(ctx, capacityFixture(), time.Now())
	if d.Status != "unavailable" {
		t.Fatal(d)
	}
	for _, r := range d.Rows {
		if r.Available != nil {
			t.Fatal(r)
		}
	}
}

func capacityMultiGPUFixture(count int) CapacityInput {
	input := capacityFixture()
	input.Slices = nil
	for i := range count {
		part := capacityFixture()
		for _, slice := range part.Slices {
			slice.Name += fmt.Sprintf("-%d", i)
			slice.Spec.Pool.Name = fmt.Sprintf("pool-%d", i)
			input.Slices = append(input.Slices, slice)
		}
	}
	return input
}

func BenchmarkCapacityEightGPUs(b *testing.B) {
	input := capacityMultiGPUFixture(8)
	b.ReportAllocs()
	for b.Loop() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		d := BuildCapacity(ctx, input, time.Now())
		cancel()
		if d.Status != "available" || d.Rows[2].Available == nil || *d.Rows[2].Available != 16 {
			b.Fatalf("capacity calculation: %+v", d)
		}
	}
}
