package app

import (
	"context"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/model"
	v1 "github.com/intellisys-stevens/leviathan/plugin/v1"
)

func TestNativeSourcePreservesAvailabilityAndCachedSourceTime(t *testing.T) {
	at := time.Now().UTC().Add(-time.Second)
	payloads := []struct {
		name       string
		capability v1.Capability
		make       func(model.MetricStatus) v1.Observation
	}{
		{"host", v1.Host, func(status model.MetricStatus) v1.Observation {
			return v1.Observation{Host: &v1.HostData{System: model.System{Status: status}}}
		}},
		{"processes", v1.Processes, func(status model.MetricStatus) v1.Observation {
			return v1.Observation{Processes: &v1.ProcessData{Capability: model.ProviderState{Status: status}}}
		}},
		{"NVIDIA GPU", v1.GPU, func(status model.MetricStatus) v1.Observation {
			return v1.Observation{GPU: &v1.GPUData{Capabilities: model.Capabilities{NVML: model.ProviderState{Status: status}}}}
		}},
		{"generic GPU", v1.GPU, func(status model.MetricStatus) v1.Observation {
			return v1.Observation{GPU: &v1.GPUData{Capabilities: model.Capabilities{NVML: model.ProviderState{Status: model.StatusUnsupported}, GPU: &model.ProviderState{Name: "custom_sensor", Status: status}}}}
		}},
	}
	for _, payload := range payloads {
		for _, state := range []struct {
			source model.MetricStatus
			want   string
		}{{model.StatusAvailable, "available"}, {model.StatusEstimated, "available"}, {model.StatusUnsupported, "unsupported"}, {model.StatusStale, "stale"}, {model.StatusError, "error"}, {model.StatusPermissionDenied, "unavailable"}, {"", "unavailable"}} {
			t.Run(payload.name+"/"+string(state.source), func(t *testing.T) {
				source := newNative("sensor", "test", payload.capability)
				source.read = func(context.Context, v1.Capability, time.Time) (v1.Observation, error) {
					o := payload.make(state.source)
					o.ObservedAt = at
					return o, nil
				}
				first, err := source.Read(context.Background(), payload.capability, at.Add(time.Second))
				if err != nil {
					t.Fatal(err)
				}
				second, err := source.Read(context.Background(), payload.capability, at.Add(2*time.Second))
				if err != nil {
					t.Fatal(err)
				}
				if first.Status != state.want || second.Status != state.want {
					t.Fatalf("source %q mapped to %q/%q instead of %q", state.source, first.Status, second.Status, state.want)
				}
				if first.Revision != second.Revision || !first.ObservedAt.Equal(at) || !second.ObservedAt.Equal(at) || first.InstanceID != "sensor" {
					t.Fatal("cached source identity or freshness changed")
				}
			})
		}
	}
}

func TestNativeSourceRejectsMissingSourceTime(t *testing.T) {
	source := newNative("bridge", "test", v1.GPUCapacity)
	source.read = func(context.Context, v1.Capability, time.Time) (v1.Observation, error) {
		return v1.Observation{Status: "unavailable"}, nil
	}
	for i := range 2 {
		observation, err := source.Read(context.Background(), v1.GPUCapacity, time.Now().Add(time.Duration(i)*time.Second))
		if err == nil || !observation.ObservedAt.IsZero() || source.revisions[v1.GPUCapacity] != 0 {
			t.Fatalf("missing source time became a new observation: %+v error=%v", observation, err)
		}
	}
}
