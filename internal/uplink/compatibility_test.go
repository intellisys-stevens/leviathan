package uplink

import (
	"errors"
	"github.com/intellisys-stevens/leviathan/model"
	"testing"
)

func TestCustomSourcesRemainLocalWithoutRelabeling(t *testing.T) {
	snapshot := projectionSnapshot()
	metric := snapshot.GPUs[0].Metrics["sm_activity"]
	metric.Source = "example_fixture"
	snapshot.GPUs[0].Metrics["sm_activity"] = metric
	snapshot.System.Storage.Filesystems[0].Source = "example_fs"
	envelope, err := Project(snapshot, model.BuildInfo{}, testStreamID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := envelope.GPUs[0].Metrics["sm_activity"]; exists {
		t.Fatal("custom metric source crossed locked uplink")
	}
	if len(envelope.System.Storage.Filesystems) != 0 {
		t.Fatal("custom filesystem was disguised as statfs")
	}
	if got := CompatibilityDiagnostics(snapshot); len(got) != 1 || got[0].Code != "uplink_omitted_observations" {
		t.Fatalf("diagnostics = %+v", got)
	}
	if snapshot.GPUs[0].Metrics["sm_activity"].Source != "example_fixture" {
		t.Fatal("projection mutated local source")
	}
	snapshot.System.CPU.Source = "example_fixture"
	if _, err = Project(snapshot, model.BuildInfo{}, testStreamID, 2); !errors.Is(err, ErrUnsupportedObservation) {
		t.Fatalf("required custom source: %v", err)
	}
}

func TestSupportedFilesystemProvenanceIsPreserved(t *testing.T) {
	snapshot := projectionSnapshot()
	snapshot.System.Storage.Filesystems[0].Source = model.SourceSynthetic
	snapshot.System.Storage.Source = model.SourceSynthetic
	envelope, err := Project(snapshot, model.BuildInfo{}, testStreamID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.System.Storage.Filesystems[0].Source != "synthetic" || envelope.System.Storage.Source != "synthetic" {
		t.Fatal("filesystem provenance changed")
	}
}
