package dcgm

import (
	"testing"

	ndcgm "github.com/NVIDIA/go-dcgm/pkg/dcgm"
)

func TestGPUActivityProfilingFieldIsCollected(t *testing.T) {
	found := false
	for _, field := range profileFields {
		if field == ndcgm.DCGM_FI_PROF_GR_ENGINE_UTIL_RATIO {
			found = true
			break
		}
	}
	if !found || profileNames[ndcgm.DCGM_FI_PROF_GR_ENGINE_UTIL_RATIO] != "gpu_activity" {
		t.Fatalf("GPU activity DCGM mapping is missing: fields=%v names=%v", profileFields, profileNames)
	}
}
