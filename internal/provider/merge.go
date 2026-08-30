package provider

import "github.com/intellisys-stevens/miglens/internal/model"

var sourceRank = map[model.MetricSource]int{
	model.SourceSynthetic: 0,
	model.SourceNVML:      10,
	model.SourceDCGM:      20,
	model.SourceNVMLGPM:   30,
}

// MergeMetric applies MIGLens' canonical precedence: available GPM, DCGM, then NVML.
// An available lower-priority value beats an unavailable higher-priority value.
func MergeMetric(current, candidate model.Metric) model.Metric {
	if current.Status != model.StatusAvailable && candidate.Status == model.StatusAvailable {
		return candidate
	}
	if current.Status == model.StatusAvailable && candidate.Status != model.StatusAvailable {
		return current
	}
	if sourceRank[candidate.Source] > sourceRank[current.Source] {
		return candidate
	}
	return current
}

func MergeMetricSets(target, candidate model.MetricSet) model.MetricSet {
	if target == nil {
		target = make(model.MetricSet)
	}
	for name, metric := range candidate {
		if existing, ok := target[name]; ok {
			target[name] = MergeMetric(existing, metric)
		} else {
			target[name] = metric
		}
	}
	return target
}
