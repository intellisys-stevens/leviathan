package tui

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/intellisys-stevens/miglens/internal/history"
	"github.com/intellisys-stevens/miglens/internal/model"
	"github.com/intellisys-stevens/miglens/internal/provider/fake"
)

type tuiSource struct {
	snapshot model.Snapshot
}

func (s tuiSource) Current() (model.Snapshot, bool) { return s.snapshot, true }
func (s tuiSource) Subscribe() (<-chan model.Snapshot, func()) {
	updates := make(chan model.Snapshot)
	return updates, func() { close(updates) }
}
func (s tuiSource) History(entity string, metrics []string, window time.Duration, _ time.Time) history.Series {
	points := []history.Point{}
	for index, value := range []float64{8, 21, 55, 34, 72} {
		points = append(points, history.Point{SampledAt: time.Date(2026, 8, 29, 12, 0, index, 0, time.UTC), Values: map[string]float64{"sm_activity": value}})
	}
	return history.Series{Entity: entity, Metrics: metrics, Window: window.String(), Points: points}
}

func fixtureModel(t *testing.T, width, height int) Model {
	t.Helper()
	provider, err := fake.NewFixture("blackwell")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := provider.Sample(context.Background(), time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	snapshot.Host.Hostname = "test-host"
	snapshot.Sequence = 7
	input := textinput.New()
	return Model{source: tuiSource{snapshot: snapshot}, snapshot: snapshot, width: width, height: height, search: input, noColor: true, ascii: true}
}

func TestViewSnapshots(t *testing.T) {
	tests := []struct {
		name     string
		width    int
		height   int
		tab      int
		expected string
	}{
		{name: "wide-details", width: 120, height: 36, tab: 0, expected: "38478a51d33d80f983693c1f24555de3e6762797348b31aaa2f7f94af0e851ec"},
		{name: "narrow-processes", width: 64, height: 24, tab: 1, expected: "ae3c8b87081136f7216404441cb289ab2b85a0f9fa34758bd1ba6d96e8af5a89"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			view := fixtureModel(t, test.width, test.height)
			view.tab = test.tab
			digest := fmt.Sprintf("%x", sha256.Sum256([]byte(view.View())))
			if digest != test.expected {
				t.Fatalf("view snapshot changed: got %s\n%s", digest, view.View())
			}
		})
	}
}

func TestNavigationAndProcessRows(t *testing.T) {
	view := fixtureModel(t, 100, 30)
	updated, _ := view.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	view = updated.(Model)
	if view.selected != 1 {
		t.Fatalf("j selected %d", view.selected)
	}
	updated, _ = view.Update(tea.KeyMsg{Type: tea.KeyTab})
	view = updated.(Model)
	if view.tab != 1 || !strings.Contains(view.View(), "4100") {
		t.Fatal("process tab does not include GPU-connected fixture processes")
	}
	for _, key := range []string{"/", "enter", "p", "?"} {
		updated, _ = view.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(key)})
		view = updated.(Model)
	}
	if !view.paused || !view.help {
		t.Fatalf("key states: paused=%v help=%v", view.paused, view.help)
	}
	_, command := view.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	if command == nil {
		t.Fatal("q did not return a quit command")
	}
}

func TestProcessSearchUsesGPUProcessIdentityOnly(t *testing.T) {
	process := model.Process{PID: 42, User: "coder", Executable: "/usr/bin/python3", CommandLine: "python3 --secret-token"}
	for _, query := range []string{"42", "coder", "python3"} {
		if !matchesProcess(process, query) {
			t.Fatalf("GPU process identity %q was not searchable", query)
		}
	}
	if matchesProcess(process, "secret-token") {
		t.Fatal("command arguments unexpectedly participate in process filtering")
	}
}

func TestNonMIGFixtureHasPhysicalGPUDetails(t *testing.T) {
	provider, _ := fake.NewFixture("non-mig")
	snapshot, err := provider.Sample(context.Background(), time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	view := Model{source: tuiSource{snapshot: snapshot}, snapshot: snapshot, width: 100, height: 30, search: textinput.New(), noColor: true, ascii: true}
	details := strings.Join(view.detailLines(48), "\n")
	if !strings.Contains(details, "physical device") || !strings.Contains(details, "GPU memory") || !strings.Contains(details, "GPU processes  1 connected") {
		t.Fatalf("non-MIG detail view is incomplete:\n%s", details)
	}
}

func TestIncompleteGPUProcessIsRenderedExplicitly(t *testing.T) {
	provider, _ := fake.NewFixture("permission-denied")
	snapshot, err := provider.Sample(context.Background(), time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	view := Model{source: tuiSource{snapshot: snapshot}, snapshot: snapshot, width: 100, height: 30, tab: 1, search: textinput.New(), noColor: true, ascii: true}
	rendered := view.View()
	if !strings.Contains(rendered, "permission_denied") || strings.Contains(rendered, "unallocated") {
		t.Fatalf("incomplete GPU process is misleading:\n%s", rendered)
	}
}
