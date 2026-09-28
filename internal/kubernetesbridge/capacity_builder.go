package kubernetesbridge

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/gpucapacity"
	corev1 "k8s.io/api/core/v1"
	resourcev1 "k8s.io/api/resource/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/sets"
	"k8s.io/dynamic-resource-allocation/cel"
	"k8s.io/dynamic-resource-allocation/structured"
	"k8s.io/utils/ptr"
)

// CapacityInput is private source state. Unlike attribution, Claims contains
// every namespace and every owner, including allocated claims without consumers.
type CapacityInput struct {
	Node    *corev1.Node
	Driver  string
	Slices  []*resourcev1.ResourceSlice
	Claims  []*resourcev1.ResourceClaim
	Classes []*resourcev1.DeviceClass
}

var capacityFeatures = structured.Features{PartitionableDevices: true, DeviceTaints: true, DeviceBindingAndStatus: true, ListTypeAttributes: true}

type capacityGroup struct {
	row                   gpucapacity.Row
	kind, class, selector string
	upper                 int64
	devices               []structured.DeviceID
}
type capacityClasses map[string]*resourcev1.DeviceClass

func (c capacityClasses) List() ([]*resourcev1.DeviceClass, error) {
	result := make([]*resourcev1.DeviceClass, 0, len(c))
	for _, class := range c {
		result = append(result, class)
	}
	return result, nil
}
func (c capacityClasses) Get(name string) (*resourcev1.DeviceClass, error) {
	if class := c[name]; class != nil {
		return class, nil
	}
	return nil, errors.New("GPU DeviceClass is unavailable")
}

// BuildCapacity uses Kubernetes' allocator on hypothetical exclusive claims.
// Every row starts from the identical allocation baseline: counts are
// alternatives, never additive, and no ResourceClaim is written to Kubernetes.
func BuildCapacity(ctx context.Context, input CapacityInput, observedAt time.Time) gpucapacity.Document {
	unknown := func(message string) gpucapacity.Document { return gpucapacity.Unavailable(message) }
	if input.Node == nil || input.Node.Name == "" || input.Driver == "" {
		return unknown("Current-node GPU capacity information is unavailable")
	}
	slices, pools, err := capacityPools(input)
	if err != nil {
		return unknown("GPU resource pools are incomplete; waiting for a complete observation")
	}
	if len(pools) == 0 {
		return unknown("No GPU DRA resource pool is advertised for this host")
	}
	groups, devices, unsupported := capacityGroups(input, slices)
	if len(groups) > gpucapacity.MaxRows {
		return unknown("GPU capacity inventory exceeds its supported size")
	}
	rows := make([]gpucapacity.Row, 0, len(groups))
	for _, group := range groups {
		rows = append(rows, group.row)
	}
	observedAt = observedAt.UTC()
	document := gpucapacity.Document{Status: "available", ObservedAt: &observedAt, Rows: rows}
	if unsupported {
		return invalidateCapacity(document, "unsupported", "This host advertises GPU sharing or device modes that this capacity preview cannot evaluate")
	}
	allocated := structured.AllocatedState{AllocatedDevices: sets.New[structured.DeviceID](), AllocatedSharedDeviceIDs: sets.New[structured.SharedDeviceID](), AggregatedCapacity: structured.NewConsumedCapacityCollection()}
	for _, claim := range input.Claims {
		if claim == nil {
			return invalidateCapacity(document, "unavailable", "GPU reservation information is incomplete")
		}
		if claim.Status.Allocation == nil {
			continue
		}
		for _, result := range claim.Status.Allocation.Devices.Results {
			if result.Driver != input.Driver || ptr.Deref(result.AdminAccess, false) {
				continue
			}
			if _, local := pools[result.Pool]; !local {
				// A known remote pool cannot consume this host's counters. An
				// absent pool is safe to ignore only with explicit remote affinity.
				if capacityKnownRemotePool(input, result.Pool) {
					continue
				}
				matches, matchErr := structured.NodeMatches(capacityFeatures, input.Node, "", false, claim.Status.Allocation.NodeSelector)
				if claim.Status.Allocation.NodeSelector != nil && matchErr == nil && !matches {
					continue
				}
				return invalidateCapacity(document, "unavailable", "A GPU reservation cannot be resolved against the current pools")
			}
			id := structured.MakeDeviceID(result.Driver, result.Pool, result.Device)
			if _, exists := devices[id]; !exists {
				return invalidateCapacity(document, "unavailable", "A GPU reservation cannot be resolved against the current pools")
			}
			if result.ShareID != nil || len(result.ConsumedCapacity) > 0 {
				return invalidateCapacity(document, "unsupported", "Shared GPU allocations are not supported by this capacity preview")
			}
			if allocated.AllocatedDevices.Has(id) {
				return invalidateCapacity(document, "unavailable", "Conflicting GPU reservations require a fresh observation")
			}
			allocated.AllocatedDevices.Insert(id)
		}
	}
	classes := capacityClasses{}
	if !validCapacityCounterState(slices, devices, allocated.AllocatedDevices) {
		return invalidateCapacity(document, "unavailable", "GPU partition counters or reservations are inconsistent")
	}
	for _, class := range input.Classes {
		if class != nil {
			classes[class.Name] = class
		}
	}
	cache := cel.NewCache(256, cel.Features{EnableListTypeAttributes: true})
	allocator, err := structured.NewAllocator(ctx, capacityFeatures, allocated, classes, slices, cache)
	if err != nil {
		return invalidateCapacity(document, "unavailable", "GPU capacity could not be evaluated")
	}
	budgets, integerCounters := capacityCounterBudgets(slices, devices, allocated.AllocatedDevices)
	availableRows := 0
	for i, group := range groups {
		row := &document.Rows[i]
		class := classes[group.class]
		if class == nil {
			row.Message = "GPU DeviceClass is not installed"
			continue
		}
		// Driver configuration can change exclusivity (MPS/time slicing).
		// Default NVIDIA classes have no configuration; unknown opaque
		// class configuration is deliberately not guessed here.
		if len(class.Spec.Config) != 0 {
			row.Status, row.Message = "unsupported", "Configured GPU sharing modes are not supported"
			continue
		}
		if group.selector == "" {
			row.Message = "GPU model, profile, or memory capacity is incomplete"
			continue
		}
		if group.upper > 16384 {
			row.Message = "GPU capacity inventory exceeds its supported size"
			continue
		}
		low, high := int64(0), capacityUpperBound(group, devices, allocated.AllocatedDevices, budgets, integerCounters)
		valid := true
		for low < high {
			count := low + (high-low+1)/2
			claims := hypotheticalCapacityClaims(group, count)
			result, err := allocator.Allocate(ctx, input.Node, claims)
			if err != nil {
				valid = false
				break
			}
			if len(result) == len(claims) {
				low = count
			} else {
				high = count - 1
			}
		}
		if ctx.Err() != nil {
			return invalidateCapacity(document, "unavailable", "GPU capacity evaluation exceeded its time limit")
		}
		if !valid {
			row.Message = "GPU capacity could not be evaluated"
			continue
		}
		row.Available, row.Status = ptr.To(low), "available"
		availableRows++
	}
	if availableRows != len(document.Rows) {
		document.Status = "partial"
		if availableRows == 0 {
			document.Status = "unavailable"
		}
		document.Message = "Some GPU capacity information is unavailable"
	}
	return document
}

func hypotheticalCapacityClaims(group capacityGroup, count int64) []*resourcev1.ResourceClaim {
	claims := []*resourcev1.ResourceClaim{}
	for count > 0 {
		n := min(count, int64(resourcev1.AllocationResultsMaxSize))
		claims = append(claims, &resourcev1.ResourceClaim{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("capacity-preview-%d", len(claims)), Namespace: "capacity-preview"}, Spec: resourcev1.ResourceClaimSpec{Devices: resourcev1.DeviceClaim{Requests: []resourcev1.DeviceRequest{{Name: "gpu", Exactly: &resourcev1.ExactDeviceRequest{DeviceClassName: group.class, AllocationMode: resourcev1.DeviceAllocationModeExactCount, Count: n, Selectors: []resourcev1.DeviceSelector{{CEL: &resourcev1.CELDeviceSelector{Expression: group.selector}}}}}}}}})
		count -= n
	}
	return claims
}

func invalidateCapacity(d gpucapacity.Document, status, message string) gpucapacity.Document {
	d.Status, d.Message = status, message
	for i := range d.Rows {
		d.Rows[i].Available = nil
		d.Rows[i].Status = "unavailable"
		if status == "unsupported" {
			d.Rows[i].Status = "unsupported"
		}
	}
	return d
}

// Only the newest generation is admissible. Waiting for missing newest slices
// must never fall back to an older, apparently free generation.
func capacityPools(input CapacityInput) ([]*resourcev1.ResourceSlice, map[string]bool, error) {
	all := map[string][]*resourcev1.ResourceSlice{}
	for _, slice := range input.Slices {
		if slice != nil && slice.Spec.Driver == input.Driver {
			all[slice.Spec.Pool.Name] = append(all[slice.Spec.Pool.Name], slice)
		}
	}
	result, localPools := []*resourcev1.ResourceSlice{}, map[string]bool{}
	for name, versions := range all {
		generation := int64(-1)
		for _, slice := range versions {
			generation = max(generation, slice.Spec.Pool.Generation)
		}
		latest := []*resourcev1.ResourceSlice{}
		local := false
		for _, slice := range versions {
			if slice.Spec.Pool.Generation != generation {
				continue
			}
			latest = append(latest, slice)
			match, err := capacitySliceMatches(input.Node, slice)
			if err != nil {
				return nil, nil, err
			}
			local = local || match
		}
		if !local {
			continue
		}
		expected := latest[0].Spec.Pool.ResourceSliceCount
		for _, slice := range latest {
			if expected <= 0 || expected != slice.Spec.Pool.ResourceSliceCount {
				return nil, nil, errors.New("inconsistent pool")
			}
		}
		if int64(len(latest)) != expected {
			return nil, nil, errors.New("incomplete pool")
		}
		seen := map[string]bool{}
		for _, slice := range latest {
			if seen[slice.Name] {
				return nil, nil, errors.New("duplicate slice")
			}
			seen[slice.Name] = true
		}
		localPools[name] = true
		result = append(result, latest...)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, localPools, nil
}

func capacitySliceMatches(node *corev1.Node, slice *resourcev1.ResourceSlice) (bool, error) {
	if ptr.Deref(slice.Spec.PerDeviceNodeSelection, false) {
		for _, device := range slice.Spec.Devices {
			matches, err := structured.NodeMatches(capacityFeatures, node, ptr.Deref(device.NodeName, ""), ptr.Deref(device.AllNodes, false), device.NodeSelector)
			if err != nil || matches {
				return matches, err
			}
		}
		// Counter-only slices are included with the rest of a local pool.
		return false, nil
	}
	return structured.NodeMatches(capacityFeatures, node, ptr.Deref(slice.Spec.NodeName, ""), ptr.Deref(slice.Spec.AllNodes, false), slice.Spec.NodeSelector)
}

func capacityKnownRemotePool(input CapacityInput, pool string) bool {
	found := false
	for _, slice := range input.Slices {
		if slice != nil && slice.Spec.Driver == input.Driver && slice.Spec.Pool.Name == pool {
			matches, err := capacitySliceMatches(input.Node, slice)
			if err != nil || matches {
				return false
			}
			found = true
		}
	}
	return found
}

func capacityGroups(input CapacityInput, slices []*resourcev1.ResourceSlice) ([]capacityGroup, map[structured.DeviceID]resourcev1.Device, bool) {
	byKey := map[string]*capacityGroup{}
	devices := map[structured.DeviceID]resourcev1.Device{}
	full := map[string]resourcev1.Device{}
	migs := map[string][]resourcev1.Device{}
	unsupported := false
	for _, slice := range slices {
		for _, device := range slice.Spec.Devices {
			id := structured.MakeDeviceID(input.Driver, slice.Spec.Pool.Name, device.Name)
			if _, duplicate := devices[id]; duplicate {
				unsupported = true
			}
			devices[id] = device
			if ptr.Deref(slice.Spec.PerDeviceNodeSelection, false) {
				match, err := structured.NodeMatches(capacityFeatures, input.Node, ptr.Deref(device.NodeName, ""), ptr.Deref(device.AllNodes, false), device.NodeSelector)
				if err != nil {
					unsupported = true
				}
				if !match {
					continue
				}
			}
			kind, _ := stringAttribute(device, input.Driver, "type")
			if kind != "gpu" && kind != "mig" {
				unsupported = true
				continue
			}
			if ptr.Deref(device.AllowMultipleAllocations, false) || len(device.NodeAllocatableResources) > 0 {
				unsupported = true
			}
			for _, consumption := range device.ConsumesCounters {
				if len(consumption.CompatibilityGroups) > 0 {
					unsupported = true
				}
			}
			model, modelOK := stringAttribute(device, input.Driver, "productName")
			if !modelOK {
				model = "GPU"
			}
			profile, profileOK := stringAttribute(device, input.Driver, "profile")
			mode, class := "native", "gpu.nvidia.com"
			if kind == "mig" {
				mode, class = "mig", "mig.nvidia.com"
			} else {
				profile = ""
			}
			var memory *int64
			for _, key := range []resourcev1.QualifiedName{"memory", resourcev1.QualifiedName(input.Driver + "/memory")} {
				if capacity, exists := device.Capacity[key]; exists {
					value, exact := capacity.Value.AsInt64()
					if exact && value > 0 && (memory == nil || *memory == value) {
						memory = ptr.To(value)
					} else {
						memory = nil
						break
					}
				}
			}
			key := mode + "\x00" + model + "\x00" + profile + "\x00" + strconv.FormatInt(ptr.Deref(memory, 0), 10)
			group := byKey[key]
			if group == nil {
				group = &capacityGroup{row: gpucapacity.Row{ID: HashRef("capacity_", key), Mode: mode, Model: model, Profile: profile, MemoryBytes: memory, Status: "unavailable"}, kind: kind, class: class}
				if modelOK && memory != nil && (kind != "mig" || profileOK) {
					domain := strconv.Quote(input.Driver)
					parts := []string{"device.driver == " + domain, "device.attributes[" + domain + "].type == " + strconv.Quote(kind), "device.attributes[" + domain + "].productName == " + strconv.Quote(model), "device.capacity[" + domain + "].memory.compareTo(quantity(" + strconv.Quote(strconv.FormatInt(*memory, 10)) + ")) == 0"}
					if kind == "mig" {
						parts = append(parts, "device.attributes["+domain+"].profile == "+strconv.Quote(profile))
					}
					group.selector = strings.Join(parts, " && ")
				}
				byKey[key] = group
			}
			group.upper++
			group.devices = append(group.devices, id)
			if kind == "gpu" {
				if uuid, ok := stringAttribute(device, input.Driver, "uuid"); ok {
					full[slice.Spec.Pool.Name+"/"+uuid] = device
				}
			}
			if kind == "mig" {
				parent, _ := stringAttribute(device, input.Driver, "parentUUID")
				if parent != "" {
					migs[slice.Spec.Pool.Name+"/"+parent] = append(migs[slice.Spec.Pool.Name+"/"+parent], device)
				}
				if _, static := stringAttribute(device, input.Driver, "uuid"); !static && len(device.ConsumesCounters) == 0 {
					unsupported = true
				}
			}
		}
	}
	for parent, partitions := range migs {
		if gpu, exists := full[parent]; exists {
			for _, mig := range partitions {
				overlap := false
				for _, a := range gpu.ConsumesCounters {
					for _, b := range mig.ConsumesCounters {
						if a.CounterSet == b.CounterSet {
							for key, av := range a.Counters {
								if bv, ok := b.Counters[key]; ok && av.Value.Sign() > 0 && bv.Value.Sign() > 0 {
									overlap = true
								}
							}
						}
					}
				}
				if !overlap {
					unsupported = true
				}
			}
		}
	}
	groups := make([]capacityGroup, 0, len(byKey))
	for _, group := range byKey {
		groups = append(groups, *group)
	}
	sort.Slice(groups, func(i, j int) bool {
		a, b := groups[i].row, groups[j].row
		if a.Mode != b.Mode {
			return a.Mode == "native"
		}
		if ptr.Deref(a.MemoryBytes, 0) != ptr.Deref(b.MemoryBytes, 0) {
			return ptr.Deref(a.MemoryBytes, 0) > ptr.Deref(b.MemoryBytes, 0)
		}
		if a.Model != b.Model {
			return a.Model < b.Model
		}
		return a.Profile < b.Profile
	})
	return groups, devices, unsupported
}

type capacityCounterKey struct{ pool, set string }

// Validate counter references before a zero upper bound can skip allocation.
// Kubernetes' Allocate(nil) is not a complete pool validation operation.
func validCapacityCounterState(slices []*resourcev1.ResourceSlice, devices map[structured.DeviceID]resourcev1.Device, allocated sets.Set[structured.DeviceID]) bool {
	remaining := map[capacityCounterKey]map[string]resource.Quantity{}
	for _, slice := range slices {
		for _, set := range slice.Spec.SharedCounters {
			key := capacityCounterKey{slice.Spec.Pool.Name, set.Name}
			if _, duplicate := remaining[key]; duplicate {
				return false
			}
			values := map[string]resource.Quantity{}
			for name, counter := range set.Counters {
				if counter.Value.Sign() < 0 {
					return false
				}
				values[name] = counter.Value.DeepCopy()
			}
			remaining[key] = values
		}
	}
	for id, device := range devices {
		for _, used := range device.ConsumesCounters {
			values, exists := remaining[capacityCounterKey{id.Pool.String(), used.CounterSet}]
			if !exists {
				return false
			}
			for name, counter := range used.Counters {
				value, exists := values[name]
				if !exists || counter.Value.Sign() < 0 {
					return false
				}
				if allocated.Has(id) {
					value.Sub(counter.Value)
					if value.Sign() < 0 {
						return false
					}
					values[name] = value
				}
			}
		}
	}
	return true
}

// The allocator performs the final feasibility checks. This inexpensive bound
// prevents asking it to exhaustively disprove impossible counts derived from
// many overlapping advertised placements. Integer arithmetic never rounds a
// feasible count down; unusual fractional/overflowing counters simply retain
// the looser advertised-device bound and the normal calculation deadline.
func capacityCounterBudgets(slices []*resourcev1.ResourceSlice, devices map[structured.DeviceID]resourcev1.Device, allocated sets.Set[structured.DeviceID]) (map[capacityCounterKey]map[string]int64, bool) {
	budgets := map[capacityCounterKey]map[string]int64{}
	for _, slice := range slices {
		for _, set := range slice.Spec.SharedCounters {
			values := map[string]int64{}
			for name, counter := range set.Counters {
				value, exact := counter.Value.AsInt64()
				if !exact || value < 0 {
					return nil, false
				}
				values[name] = value
			}
			budgets[capacityCounterKey{slice.Spec.Pool.Name, set.Name}] = values
		}
	}
	for id := range allocated {
		for _, used := range devices[id].ConsumesCounters {
			values := budgets[capacityCounterKey{id.Pool.String(), used.CounterSet}]
			for name, counter := range used.Counters {
				value, exact := counter.Value.AsInt64()
				remaining, exists := values[name]
				if !exact || value < 0 || !exists || remaining < value {
					return nil, false
				}
				values[name] = remaining - value
			}
		}
	}
	return budgets, true
}

func capacityUpperBound(group capacityGroup, devices map[structured.DeviceID]resourcev1.Device, allocated sets.Set[structured.DeviceID], budgets map[capacityCounterKey]map[string]int64, integerCounters bool) int64 {
	if !integerCounters {
		return group.upper
	}
	type subset struct {
		count, minimumCost int64
		used               map[string]bool
	}
	byCounter := map[capacityCounterKey]*subset{}
	loose := int64(0)
	for _, id := range group.devices {
		if allocated.Has(id) {
			continue
		}
		device := devices[id]
		if len(device.ConsumesCounters) != 1 {
			loose++
			continue
		}
		consumption := device.ConsumesCounters[0]
		key := capacityCounterKey{id.Pool.String(), consumption.CounterSet}
		budget, exists := budgets[key]
		if !exists {
			return group.upper
		}
		cost, fits := int64(0), true
		for name, counter := range consumption.Counters {
			value, exact := counter.Value.AsInt64()
			if !exact || value < 0 || value > math.MaxInt64-cost {
				return group.upper
			}
			if value > budget[name] {
				fits = false
			}
			cost += value
		}
		if !fits {
			continue
		}
		if cost == 0 {
			loose++
			continue
		}
		set := byCounter[key]
		if set == nil {
			set = &subset{minimumCost: cost, used: map[string]bool{}}
			byCounter[key] = set
		}
		set.count++
		set.minimumCost = min(set.minimumCost, cost)
		for name := range consumption.Counters {
			set.used[name] = true
		}
	}
	bound := loose
	for key, set := range byCounter {
		total := int64(0)
		for name := range set.used {
			value := budgets[key][name]
			if value > math.MaxInt64-total {
				return group.upper
			}
			total += value
		}
		bound += min(set.count, total/set.minimumCost)
	}
	return min(group.upper, bound)
}
