package model

import (
	"errors"
	"regexp"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	GPUCapacityStaleAfter       = 15 * time.Second
	GPUCapacityMaxDocumentBytes = 64 << 10
	GPUCapacityMaxRows          = 128
)

type GPUCapacityRow struct {
	ID          string `json:"id"`
	Mode        string `json:"mode"`
	Model       string `json:"model"`
	Profile     string `json:"profile,omitempty"`
	MemoryBytes *int64 `json:"memoryBytes"`
	Available   *int64 `json:"available"`
	Status      string `json:"status"`
	Message     string `json:"message,omitempty"`
}

type GPUCapacityDocument struct {
	Status     string           `json:"status"`
	ObservedAt *time.Time       `json:"observedAt,omitempty"`
	Revision   uint64           `json:"revision"`
	Rows       []GPUCapacityRow `json:"rows"`
	Message    string           `json:"message,omitempty"`
}

func UnavailableGPUCapacity(message string) GPUCapacityDocument {
	return GPUCapacityDocument{Status: "unavailable", Rows: []GPUCapacityRow{}, Message: message}
}

// At suppresses every actionable count once its source observation expires.
// Re-reading a cached document cannot extend its freshness.
func (d GPUCapacityDocument) At(now time.Time) GPUCapacityDocument {
	d.Rows = append([]GPUCapacityRow{}, d.Rows...)
	if d.ObservedAt != nil && (now.Sub(*d.ObservedAt) > GPUCapacityStaleAfter || d.ObservedAt.After(now.Add(5*time.Second))) {
		d.Status, d.Message = "stale", "GPU capacity observation is stale"
		for i := range d.Rows {
			d.Rows[i].Available = nil
			d.Rows[i].Status = "unavailable"
		}
	}
	return d
}

var capacityRowID = regexp.MustCompile(`^capacity_[a-f0-9]{32}$`)

func (d GPUCapacityDocument) Validate() error {
	if !capacityOneOf(d.Status, "available", "partial", "stale", "unavailable", "unsupported") || len(d.Rows) > GPUCapacityMaxRows || !capacityDisplay(d.Message, 256, true) {
		return errors.New("invalid GPU capacity document")
	}
	if (d.Status == "available" || d.Status == "partial") && (d.ObservedAt == nil || d.ObservedAt.IsZero()) {
		return errors.New("GPU capacity observation time is missing")
	}
	seen := map[string]bool{}
	for _, row := range d.Rows {
		if !capacityRowID.MatchString(row.ID) || seen[row.ID] || !capacityOneOf(row.Mode, "native", "mig") || !capacityDisplay(row.Model, 128, false) || !capacityDisplay(row.Profile, 128, true) || !capacityDisplay(row.Message, 256, true) || !capacityOneOf(row.Status, "available", "unavailable", "unsupported") {
			return errors.New("invalid GPU capacity row")
		}
		seen[row.ID] = true
		if row.MemoryBytes != nil && *row.MemoryBytes <= 0 || row.Available != nil && (*row.Available < 0 || *row.Available > 16384) {
			return errors.New("invalid GPU capacity quantity")
		}
		if (row.Status == "available") != (row.Available != nil) || row.Available != nil && !capacityOneOf(d.Status, "available", "partial") {
			return errors.New("invalid GPU capacity availability")
		}
	}
	return nil
}

func capacityDisplay(value string, max int, empty bool) bool {
	if (!empty && value == "") || len(value) > max || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func capacityOneOf(value string, values ...string) bool {
	for _, v := range values {
		if value == v {
			return true
		}
	}
	return false
}
