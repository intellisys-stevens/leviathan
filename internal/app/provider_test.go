package app

import (
	"path/filepath"
	"testing"

	"github.com/intellisys-stevens/miglens/internal/attribution"
	"github.com/intellisys-stevens/miglens/internal/config"
)

func TestProviderWrapsFakeOnlyWhenAttributionIsConfigured(t *testing.T) {
	cfg := config.Defaults()
	cfg.Provider = "fake"

	plain, err := Provider(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, wrapped := plain.(*attribution.Provider); wrapped {
		t.Fatal("unconfigured provider unexpectedly enabled attribution")
	}

	cfg.AttributionSocket = filepath.Join(t.TempDir(), "attribution.sock")
	configured, err := Provider(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, wrapped := configured.(*attribution.Provider); !wrapped {
		t.Fatalf("configured provider type = %T", configured)
	}
}

func TestProviderWrapsRealTelemetryWhenAttributionIsConfigured(t *testing.T) {
	cfg := config.Defaults()
	cfg.Provider = "nvml"
	cfg.AttributionSocket = filepath.Join(t.TempDir(), "attribution.sock")

	configured, err := Provider(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, wrapped := configured.(*attribution.Provider); !wrapped {
		t.Fatalf("configured provider type = %T", configured)
	}
}
