// Package gpucapacity defines the aggregate-only, independent GPU feasibility
// handoff. It deliberately has no workload or physical device identifiers.
package gpucapacity

import (
	"errors"
	"regexp"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	StaleAfter       = 15 * time.Second
	MaxDocumentBytes = 64 << 10
	MaxRows          = 128
)

type Row struct {
	ID          string `json:"id"`
	Mode        string `json:"mode"`
	Model       string `json:"model"`
	Profile     string `json:"profile,omitempty"`
	MemoryBytes *int64 `json:"memoryBytes"`
	Available   *int64 `json:"available"`
	Status      string `json:"status"`
	Message     string `json:"message,omitempty"`
}

type Document struct {
	Status     string     `json:"status"`
	ObservedAt *time.Time `json:"observedAt,omitempty"`
	Revision   uint64     `json:"revision"`
	Rows       []Row      `json:"rows"`
	Message    string     `json:"message,omitempty"`
}

func Unavailable(message string) Document {
	return Document{Status: "unavailable", Rows: []Row{}, Message: message}
}

// At suppresses every actionable count once its source observation expires.
// Re-reading a cached document cannot extend its freshness.
func (d Document) At(now time.Time) Document {
	d.Rows = append([]Row{}, d.Rows...)
	if d.ObservedAt != nil && (now.Sub(*d.ObservedAt) > StaleAfter || d.ObservedAt.After(now.Add(5*time.Second))) {
		d.Status, d.Message = "stale", "GPU capacity observation is stale"
		for i := range d.Rows {
			d.Rows[i].Available = nil
			d.Rows[i].Status = "unavailable"
		}
	}
	return d
}

var rowID = regexp.MustCompile(`^capacity_[a-f0-9]{32}$`)

func (d Document) Validate() error {
	if !oneOf(d.Status, "available", "partial", "stale", "unavailable", "unsupported") || len(d.Rows) > MaxRows || !display(d.Message, 256, true) {
		return errors.New("invalid GPU capacity document")
	}
	if (d.Status == "available" || d.Status == "partial") && (d.ObservedAt == nil || d.ObservedAt.IsZero()) {
		return errors.New("GPU capacity observation time is missing")
	}
	seen := map[string]bool{}
	for _, row := range d.Rows {
		if !rowID.MatchString(row.ID) || seen[row.ID] || !oneOf(row.Mode, "native", "mig") || !display(row.Model, 128, false) || !display(row.Profile, 128, true) || !display(row.Message, 256, true) || !oneOf(row.Status, "available", "unavailable", "unsupported") {
			return errors.New("invalid GPU capacity row")
		}
		seen[row.ID] = true
		if row.MemoryBytes != nil && *row.MemoryBytes <= 0 || row.Available != nil && (*row.Available < 0 || *row.Available > 16384) {
			return errors.New("invalid GPU capacity quantity")
		}
		if (row.Status == "available") != (row.Available != nil) || row.Available != nil && !oneOf(d.Status, "available", "partial") {
			return errors.New("invalid GPU capacity availability")
		}
	}
	return nil
}

func display(value string, max int, empty bool) bool {
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

func oneOf(value string, values ...string) bool {
	for _, v := range values {
		if value == v {
			return true
		}
	}
	return false
}
