package v1

import (
	"errors"
	"fmt"
	"math"
	"reflect"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/intellisys-stevens/leviathan/model"
)

// ValidateAt checks the stateless wire contract. Ordering across reads belongs
// to Client or the embedding runtime and is scoped to capability and session.
func (o Observation) ValidateAt(now time.Time) error {
	if err := o.Validate(); err != nil {
		return err
	}
	if o.ObservedAt.After(now.Add(5 * time.Second)) {
		return errors.New("plugin observation is from the future")
	}
	// A legal 4 MiB response can contain far more than 32768 reflected fields
	// (4096 process records alone do). Derive this traversal safeguard from
	// the wire bound, allowing a pointer and value visit per serialized byte.
	// Collection and metric-map limits independently bound each payload.
	budget := 2 * MaxDocumentBytes
	return validateValue(reflect.ValueOf(o), now, &budget)
}

func metricStatus(status model.MetricStatus) bool {
	switch status {
	case model.StatusAvailable, model.StatusEstimated, model.StatusStale, model.StatusUnsupported, model.StatusPermissionDenied, model.StatusError:
		return true
	}
	return false
}

func metricScope(scope model.MetricScope) bool {
	switch scope {
	case model.ScopeHost, model.ScopePhysicalGPU, model.ScopeGPUInstance, model.ScopeComputeInstance, model.ScopeWorkloadOwner:
		return true
	}
	return false
}

func metricUnit(unit string) bool {
	switch unit {
	case "percent", "load", "bytes", "bytes_per_second", "B/s", "cores", "celsius", "watts", "mhz", "seconds":
		return true
	}
	return false
}

func validateValue(value reflect.Value, now time.Time, budget *int) error {
	*budget--
	if *budget < 0 {
		return errors.New("plugin observation exceeds entity bounds")
	}
	if value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil
		}
		return validateValue(value.Elem(), now, budget)
	}
	if value.CanInterface() {
		switch typed := value.Interface().(type) {
		case model.MetricSource:
			if !validText(string(typed), 128, true) {
				return errors.New("invalid metric source")
			}
		case model.MetricScope:
			if typed != "" && !metricScope(typed) {
				return errors.New("invalid metric scope")
			}
		case model.WorkloadPlatform:
			if !validText(string(typed), 128, true) {
				return errors.New("invalid workload platform")
			}
		case model.WorkloadKind:
			if !validText(string(typed), 128, true) {
				return errors.New("invalid workload kind")
			}
		case model.Diagnostic:
			switch typed.Severity {
			case "", "info", "warning", "error":
			default:
				return errors.New("invalid diagnostic severity")
			}
		case model.AttributionResolution:
			if typed.Status != "complete" && typed.Status != "incomplete" && typed.Status != "unknown" {
				return errors.New("invalid allocation resolution status")
			}
			if typed.UnresolvedAssignments < 0 {
				return errors.New("invalid unresolved assignment count")
			}
		case model.WorkloadAssignmentResolution:
			if typed.UnresolvedAssignments < 0 {
				return errors.New("invalid unresolved assignment count")
			}
		case model.MetricStatus:
			if typed != "" && !metricStatus(typed) {
				return errors.New("invalid metric status")
			}
		case model.WorkloadTelemetryStatus:
			switch typed {
			case model.WorkloadTelemetryAvailable, model.WorkloadTelemetryPartial, model.WorkloadTelemetryStale, model.WorkloadTelemetryUnavailable:
			default:
				return errors.New("invalid workload telemetry status")
			}
		case model.Process:
			if typed.PID == 0 || !metricStatus(typed.Status) {
				return errors.New("invalid process identity or status")
			}
		case Assignment:
			if typed.EntityType != model.AllocationEntityPhysicalGPU && typed.EntityType != model.AllocationEntityComputeInstance {
				return errors.New("invalid allocation entity type")
			}
			if typed.State != model.AllocationStateAllocated && typed.State != model.AllocationStateReserved {
				return errors.New("invalid allocation state")
			}
		case time.Time:
			if typed.After(now.Add(5 * time.Second)) {
				return errors.New("plugin source timestamp is from the future")
			}
			return nil
		case model.ProviderState:
			if typed.Status == "" && typed != (model.ProviderState{}) {
				return errors.New("unset provider state must be empty")
			}
		case model.Metric:
			if typed.Status == "" && typed.Value == nil {
				if typed != (model.Metric{}) {
					return errors.New("unset metric group must be empty")
				}
				return nil
			}
			if !metricStatus(typed.Status) || !metricScope(typed.Scope) || !metricUnit(typed.Unit) || !validText(string(typed.Source), 128, false) || typed.SampledAt.IsZero() {
				return errors.New("invalid metric provenance, unit, status or scope")
			}
			if typed.Value != nil && (math.IsNaN(*typed.Value) || math.IsInf(*typed.Value, 0)) {
				return errors.New("metric value must be finite")
			}
		case model.Memory:
			if typed.Status == "" && typed.TotalBytes == nil && typed.UsedBytes == nil && typed.FreeBytes == nil && typed != (model.Memory{}) {
				return errors.New("unset memory group must be empty")
			}
			if typed.Status != "" || typed.TotalBytes != nil || typed.UsedBytes != nil || typed.FreeBytes != nil {
				if !metricStatus(typed.Status) || !metricScope(typed.Scope) || !validText(string(typed.Source), 128, false) || typed.SampledAt.IsZero() {
					return errors.New("invalid memory provenance, status or scope")
				}
			}
		case model.WorkloadAttribution:
			if !validText(typed.Ref, 512, false) || !validText(string(typed.Platform), 128, false) || !validText(string(typed.Kind), 128, false) || !validText(typed.Name, 253, false) {
				return errors.New("invalid workload identity")
			}
		case Owner:
			if !validText(typed.Ref, 512, false) || !validText(typed.Name, 128, false) || !validText(string(typed.Platform), 128, false) {
				return errors.New("invalid owner identity")
			}
		case ScopeAssignment:
			if !validText(typed.ScopeRef, 512, false) || !validText(typed.WorkloadRef, 512, false) {
				return errors.New("invalid scope assignment")
			}
		case ResourceRef:
			if !ValidID(typed.InstanceID) || !validText(typed.ID, 512, false) {
				return errors.New("invalid resource reference")
			}
		case model.GPU:
			if !validText(typed.UUID, 512, false) || len(typed.GPUInstances) > 256 {
				return errors.New("invalid GPU identity or instance count")
			}
		case model.GPUInstance:
			if !validText(typed.UUID, 512, false) || len(typed.ComputeInstances) > 256 {
				return errors.New("invalid GPU-instance identity or count")
			}
		case model.ComputeInstance:
			if !validText(typed.UUID, 512, false) {
				return errors.New("invalid compute-instance identity")
			}
		case model.Filesystem:
			if !validText(typed.ID, 512, false) {
				return errors.New("invalid filesystem identity")
			}
		case model.WorkloadOwnerTelemetry:
			if !validText(typed.Ref, 512, false) {
				return errors.New("invalid workload owner identity")
			}
		}
	}
	switch value.Kind() {
	case reflect.Struct:
		for i := 0; i < value.NumField(); i++ {
			if err := validateValue(value.Field(i), now, budget); err != nil {
				return fmt.Errorf("%s: %w", value.Type().Field(i).Name, err)
			}
		}
	case reflect.Slice:
		if value.Len() > 4096 {
			return errors.New("plugin collection exceeds entity bounds")
		}
		seen := map[string]bool{}
		for i := 0; i < value.Len(); i++ {
			item := value.Index(i)
			if item.Kind() == reflect.Struct {
				for _, name := range []string{"UUID", "Ref", "ID"} {
					field := item.FieldByName(name)
					if field.IsValid() && field.Kind() == reflect.String {
						id := field.String()
						if id != "" && seen[id] {
							return errors.New("duplicate entity identity")
						}
						seen[id] = true
						break
					}
				}
			}
			if err := validateValue(item, now, budget); err != nil {
				return err
			}
		}
	case reflect.Map:
		if value.Len() > 256 {
			return errors.New("plugin metric map exceeds bounds")
		}
		iter := value.MapRange()
		for iter.Next() {
			if err := validateValue(iter.Key(), now, budget); err != nil {
				return err
			}
			if err := validateValue(iter.Value(), now, budget); err != nil {
				return err
			}
		}
	case reflect.String:
		if !validText(value.String(), 4096, true) {
			return errors.New("invalid text value")
		}
	case reflect.Float64, reflect.Float32:
		if math.IsNaN(value.Float()) || math.IsInf(value.Float(), 0) {
			return errors.New("non-finite value")
		}
	}
	return nil
}

func validText(value string, limit int, empty bool) bool {
	if !empty && value == "" || len(value) > limit || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
