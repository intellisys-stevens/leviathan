package tui

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/intellisys-stevens/leviathan/internal/config"
	"github.com/intellisys-stevens/leviathan/internal/history"
	"github.com/intellisys-stevens/leviathan/internal/model"
	"github.com/intellisys-stevens/leviathan/internal/render"
)

type DataSource interface {
	Current() (model.Snapshot, bool)
	History(entity string, metrics []string, window time.Duration, now time.Time) history.Series
	Subscribe() (<-chan model.Snapshot, func())
}

type snapshotMsg model.Snapshot

type selection struct {
	gpu int
	gi  int
	ci  int
}

type Model struct {
	source      DataSource
	events      <-chan model.Snapshot
	unsubscribe func()
	snapshot    model.Snapshot
	selected    int
	tab         int
	width       int
	height      int
	paused      bool
	help        bool
	expanded    bool
	searching   bool
	search      textinput.Model
	noColor     bool
	ascii       bool
}

func Run(ctx context.Context, source DataSource, cfg config.Config) error {
	events, unsubscribe := source.Subscribe()
	input := textinput.New()
	input.Placeholder = "PID, user, executable"
	input.CharLimit = 120
	input.Width = 56
	model := Model{source: source, events: events, unsubscribe: unsubscribe, width: 100, height: 30, search: input, noColor: cfg.NoColor, ascii: cfg.ASCII}
	program := tea.NewProgram(model, tea.WithAltScreen(), tea.WithContext(ctx))
	_, err := program.Run()
	unsubscribe()
	return err
}

func (m Model) Init() tea.Cmd { return waitSnapshot(m.events) }

func waitSnapshot(events <-chan model.Snapshot) tea.Cmd {
	return func() tea.Msg {
		snapshot, ok := <-events
		if !ok {
			return tea.Quit()
		}
		return snapshotMsg(snapshot)
	}
}

func (m Model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch message := message.(type) {
	case snapshotMsg:
		if !m.paused {
			m.snapshot = model.Snapshot(message)
			m.clampSelection()
		}
		return m, waitSnapshot(m.events)
	case tea.WindowSizeMsg:
		m.width, m.height = message.Width, message.Height
		m.search.Width = max(20, min(60, message.Width-12))
		return m, nil
	case tea.KeyMsg:
		if m.searching {
			switch message.String() {
			case "esc", "enter":
				m.searching = false
				m.search.Blur()
				return m, nil
			}
			var command tea.Cmd
			m.search, command = m.search.Update(message)
			return m, command
		}
		switch message.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "j", "down":
			m.selected++
			m.clampSelection()
		case "k", "up":
			m.selected--
			m.clampSelection()
		case "tab":
			m.tab = (m.tab + 1) % 3
		case "shift+tab":
			m.tab = (m.tab + 2) % 3
		case "/":
			m.searching = true
			return m, m.search.Focus()
		case "enter":
			m.expanded = !m.expanded
		case "p":
			m.paused = !m.paused
		case "?":
			m.help = !m.help
		}
	}
	return m, nil
}

func (m Model) View() string {
	if m.snapshot.SampledAt.IsZero() {
		return "\n  Leviathan is opening NVIDIA providers…\n"
	}
	if m.help {
		return m.helpView()
	}
	contentWidth := max(40, m.width-4)
	if m.height > 0 && m.height < 28 {
		return m.compactView(contentWidth)
	}
	header := m.header(contentWidth)
	search := ""
	if m.searching || m.search.Value() != "" {
		search = "\n" + m.style("search", "  / "+m.search.View()) + "\n"
	}
	left := m.overview(max(36, contentWidth/2-1))
	right := m.details(max(36, contentWidth/2-1))
	body := ""
	if contentWidth >= 92 {
		body = lipgloss.JoinHorizontal(lipgloss.Top, left, "  ", right)
	} else {
		body = left + "\n\n" + right
	}
	footer := m.footer(contentWidth)
	return header + search + "\n" + body + "\n" + footer
}

func (m Model) compactView(width int) string {
	lines := []string{m.header(width), "", m.style("section", "GPU / MIG TOPOLOGY")}
	selections := m.selections()
	if len(selections) == 0 {
		lines = append(lines, m.style("muted", "No NVIDIA GPU entities detected."))
	} else {
		selected := selections[m.selected]
		gpu := m.snapshot.GPUs[selected.gpu]
		lines = append(lines, fmt.Sprintf("GPU %d  %s", gpu.Index, truncate(gpu.Name, width-9)))
		if len(gpu.GPUInstances) > 0 {
			lines = append(lines, m.migMap(gpu, width))
		}
		if selected.gi >= 0 {
			gi := gpu.GPUInstances[selected.gi]
			entity := fmt.Sprintf("> GI %d / %s", gi.ID, gi.Profile)
			if selected.ci >= 0 {
				ci := gi.ComputeInstances[selected.ci]
				entity += fmt.Sprintf(" · CI %d / %s", ci.ID, ci.Profile)
			}
			lines = append(lines, truncate(entity, width))
		}
	}
	lines = append(lines, "")
	tabs := []string{"DETAILS", "GPU PROCESSES", "DIAGNOSTICS"}
	for index := range tabs {
		if index == m.tab {
			tabs[index] = m.style("tab", tabs[index])
		} else {
			tabs[index] = m.style("muted", tabs[index])
		}
	}
	lines = append(lines, strings.Join(tabs, "  "))
	switch m.tab {
	case 0:
		lines = append(lines, m.detailLines(width)...)
	case 1:
		lines = append(lines, m.processLines(width)...)
	case 2:
		lines = append(lines, m.diagnosticLines(width)...)
	}
	maxBodyLines := max(2, m.height-1)
	if len(lines) > maxBodyLines {
		lines = append(lines[:maxBodyLines-1], m.style("muted", "…"))
	}
	return strings.Join(lines, "\n") + "\n" + m.footer(width)
}

func (m Model) header(width int) string {
	provider := "NVML"
	if m.snapshot.Capabilities.GPM.Available {
		provider += " + GPM"
	}
	if m.snapshot.Capabilities.DCGM.Available {
		provider += " + DCGM"
	}
	state := m.style("good", "● LIVE")
	if m.paused {
		state = m.style("warn", "Ⅱ PAUSED")
	}
	title := m.style("title", " Leviathan ") + "  " + m.snapshot.Host.Hostname
	right := fmt.Sprintf("%s  %s  #%d", state, provider, m.snapshot.Sequence)
	gap := max(1, width-lipgloss.Width(title)-lipgloss.Width(right))
	return title + strings.Repeat(" ", gap) + right
}

func (m Model) overview(width int) string {
	lines := []string{m.style("section", "GPU / MIG TOPOLOGY")}
	selections := m.selections()
	current := selection{gpu: -1, gi: -1, ci: -1}
	if len(selections) > 0 {
		current = selections[m.selected]
	}
	for gpuIndex, gpu := range m.snapshot.GPUs {
		temp := render.Metric(gpu.Metrics["temperature"], m.dash())
		power := render.Metric(gpu.Metrics["power"], m.dash())
		lines = append(lines, m.style("gpu", fmt.Sprintf("GPU %d  %s", gpu.Index, truncate(gpu.Name, width-10))))
		lines = append(lines, m.style("muted", fmt.Sprintf("  %s  ·  %s  ·  %s", temp, power, shortUUID(gpu.UUID))))
		if len(gpu.GPUInstances) > 0 {
			lines = append(lines, "  "+m.migMap(gpu, width-2))
		}
		for giIndex, gi := range gpu.GPUInstances {
			connector := "├─"
			if m.ascii {
				connector = "+-"
			}
			if giIndex == len(gpu.GPUInstances)-1 {
				connector = "└─"
				if m.ascii {
					connector = "\\-"
				}
			}
			line := fmt.Sprintf("%s GI %d / %s  %s  SM %s", connector, gi.ID, gi.Profile, render.Memory(gi.Memory, m.dash()), render.Metric(gi.Metrics["sm_activity"], m.dash()))
			selectedGI := current.gpu == gpuIndex && current.gi == giIndex
			if len(gi.ComputeInstances) == 1 {
				if selectedGI {
					line = m.style("selected", "> "+truncate(line, width-2))
				} else {
					line = "  " + truncate(line, width-2)
				}
				lines = append(lines, line)
				continue
			}
			lines = append(lines, "  "+truncate(line, width-2))
			for ciIndex, ci := range gi.ComputeInstances {
				ciLine := fmt.Sprintf("     CI %d / %s", ci.ID, ci.Profile)
				if selectedGI && current.ci == ciIndex {
					ciLine = m.style("selected", "> "+truncate(strings.TrimSpace(ciLine), width-2))
				}
				lines = append(lines, ciLine)
			}
		}
		if gpuIndex < len(m.snapshot.GPUs)-1 {
			lines = append(lines, "")
		}
	}
	return m.panel(strings.Join(lines, "\n"), width)
}

func (m Model) details(width int) string {
	tabs := []string{"DETAILS", "GPU PROCESSES", "DIAGNOSTICS"}
	labels := make([]string, len(tabs))
	for index, tab := range tabs {
		if index == m.tab {
			labels[index] = m.style("tab", tab)
		} else {
			labels[index] = m.style("muted", tab)
		}
	}
	lines := []string{strings.Join(labels, "  ")}
	switch m.tab {
	case 0:
		lines = append(lines, m.detailLines(width)...)
	case 1:
		lines = append(lines, m.processLines(width)...)
	case 2:
		lines = append(lines, m.diagnosticLines(width)...)
	}
	return m.panel(strings.Join(lines, "\n"), width)
}

func (m Model) detailLines(width int) []string {
	selections := m.selections()
	if len(selections) == 0 || m.selected >= len(selections) {
		return []string{"", m.style("muted", "No GPU entity selected.")}
	}
	selected := selections[m.selected]
	if selected.gi < 0 {
		return m.physicalGPUDetailLines(m.snapshot.GPUs[selected.gpu], width)
	}
	gpu, gi, ci, ok := m.selectedEntity()
	if !ok {
		return []string{"", m.style("muted", "No GPU entity selected.")}
	}
	lines := []string{"", m.style("section", fmt.Sprintf("GPU %d · GI %d · CI %d", gpu.Index, gi.ID, ci.ID)), truncate(ci.UUID, width-2), ""}
	lines = append(lines, metricRow("SM activity", gi.Metrics["sm_activity"], m.dash()), metricRow("SM occupancy", gi.Metrics["sm_occupancy"], m.dash()), metricRow("Tensor", gi.Metrics["tensor_activity"], m.dash()), metricRow("DRAM", gi.Metrics["dram_activity"], m.dash()))
	series := m.source.History(gi.UUID, []string{"sm_activity"}, 30*time.Minute, time.Now().UTC())
	values := make([]float64, 0, len(series.Points))
	for _, point := range series.Points {
		if value, ok := point.Values["sm_activity"]; ok {
			values = append(values, value)
		}
	}
	lines = append(lines, "", "30m  "+m.style("good", sparkline(values, max(12, width-8), m.ascii)), "")
	lines = append(lines, "Memory    "+render.Memory(gi.Memory, m.dash()))
	lines = append(lines, "Profile   "+gi.Profile+" / "+ci.Profile)
	if len(gi.ComputeInstances) > 1 {
		lines = append(lines, "", m.style("warn", "Activity and memory are shared at GI scope."))
	}
	if m.expanded {
		lines = append(lines, "", m.style("muted", "Metric provenance"))
		for _, name := range []string{"sm_activity", "sm_occupancy", "tensor_activity", "dram_activity"} {
			metric := gi.Metrics[name]
			lines = append(lines, fmt.Sprintf("%-14s %s / %s / %s", name, metric.Source, metric.Scope, metric.Status))
		}
	}
	return lines
}

func (m Model) physicalGPUDetailLines(gpu model.GPU, width int) []string {
	lines := []string{
		"",
		m.style("section", fmt.Sprintf("GPU %d · physical device", gpu.Index)),
		truncate(gpu.UUID, width-2),
		"",
		metricRow("SM activity", gpu.Metrics["sm_activity"], m.dash()),
		metricRow("Memory active", gpu.Metrics["memory_activity"], m.dash()),
		metricRow("Temperature", gpu.Metrics["temperature"], m.dash()),
		metricRow("Power", gpu.Metrics["power"], m.dash()),
	}
	series := m.source.History(gpu.UUID, []string{"sm_activity"}, 30*time.Minute, time.Now().UTC())
	values := make([]float64, 0, len(series.Points))
	for _, point := range series.Points {
		if value, ok := point.Values["sm_activity"]; ok {
			values = append(values, value)
		}
	}
	lines = append(lines, "", "30m  "+m.style("good", sparkline(values, max(12, width-8), m.ascii)), "")
	lines = append(lines, "GPU memory "+render.Memory(gpu.Memory, m.dash()))
	lines = append(lines, fmt.Sprintf("GPU processes  %d connected", len(m.snapshot.Processes)))
	return lines
}

func (m Model) processLines(width int) []string {
	query := strings.ToLower(strings.TrimSpace(m.search.Value()))
	lines := []string{"", "PID     USER       EXECUTABLE / COMMAND"}
	count := 0
	for _, process := range m.snapshot.Processes {
		if !matchesProcess(process, query) {
			continue
		}
		lines = append(lines, processLine(process, width))
		count++
	}
	if count == 0 {
		message := "No GPU-connected processes in the current PID namespace."
		if query != "" {
			message = "No GPU processes match this filter."
		}
		lines = append(lines, m.style("muted", message))
	}
	return lines
}

func (m Model) diagnosticLines(width int) []string {
	lines := []string{""}
	if len(m.snapshot.Diagnostics) == 0 {
		return append(lines, m.style("good", "No active diagnostics."))
	}
	for _, diagnostic := range m.snapshot.Diagnostics {
		style := "warn"
		if diagnostic.Severity == "error" {
			style = "error"
		}
		lines = append(lines, m.style(style, strings.ToUpper(string(diagnostic.Status))+" · "+diagnostic.Component), wrap(diagnostic.Summary, width-2))
		if diagnostic.Remedy != "" && (m.expanded || diagnostic.Severity == "error") {
			lines = append(lines, m.style("muted", wrap("↳ "+diagnostic.Remedy, width-2)))
		}
		lines = append(lines, "")
	}
	return lines
}

func (m Model) footer(width int) string {
	text := "j/k move   Tab view   / filter   Enter provenance   p pause   ? help   q quit"
	return m.style("muted", " "+truncate(text, width))
}

func (m Model) helpView() string {
	lines := []string{
		m.style("title", " Leviathan keys "), "",
		"j / k, arrows   Select a GPU or MIG compute instance",
		"Tab             Cycle details, processes, diagnostics",
		"/               Search GPU process PID, user, or executable",
		"Enter           Show metric source, scope, and status",
		"p               Pause/resume display updates (collection continues)",
		"?               Close this help", "q               Quit", "",
		m.style("muted", "Leviathan is read-only. Missing telemetry is never displayed as zero."),
	}
	return "\n" + m.panel(strings.Join(lines, "\n"), max(48, min(80, m.width-4)))
}

func (m *Model) clampSelection() {
	count := len(m.selections())
	if count == 0 {
		m.selected = 0
		return
	}
	if m.selected < 0 {
		m.selected = count - 1
	}
	if m.selected >= count {
		m.selected = 0
	}
}

func (m Model) selections() []selection {
	result := []selection{}
	for gpuIndex, gpu := range m.snapshot.GPUs {
		if len(gpu.GPUInstances) == 0 {
			result = append(result, selection{gpu: gpuIndex, gi: -1, ci: -1})
		}
		for giIndex, gi := range gpu.GPUInstances {
			if len(gi.ComputeInstances) == 0 {
				result = append(result, selection{gpu: gpuIndex, gi: giIndex, ci: -1})
			}
			for ciIndex := range gi.ComputeInstances {
				result = append(result, selection{gpu: gpuIndex, gi: giIndex, ci: ciIndex})
			}
		}
	}
	return result
}

func (m Model) selectedEntity() (model.GPU, model.GPUInstance, model.ComputeInstance, bool) {
	selections := m.selections()
	if len(selections) == 0 || m.selected >= len(selections) {
		return model.GPU{}, model.GPUInstance{}, model.ComputeInstance{}, false
	}
	selected := selections[m.selected]
	if selected.gi < 0 || selected.ci < 0 {
		return model.GPU{}, model.GPUInstance{}, model.ComputeInstance{}, false
	}
	gpu := m.snapshot.GPUs[selected.gpu]
	gi := gpu.GPUInstances[selected.gi]
	ci := gi.ComputeInstances[selected.ci]
	return gpu, gi, ci, true
}

func (m Model) migMap(gpu model.GPU, width int) string {
	if len(gpu.GPUInstances) == 0 {
		return ""
	}
	separator := "│"
	if m.ascii {
		separator = "|"
	}
	segments := make([]string, 0, len(gpu.GPUInstances))
	usable := max(width-len(gpu.GPUInstances)-1, len(gpu.GPUInstances)*6)
	segmentWidth := max(6, usable/len(gpu.GPUInstances))
	for _, gi := range gpu.GPUInstances {
		label := fmt.Sprintf("GI%d %s", gi.ID, render.Metric(gi.Metrics["sm_activity"], m.dash()))
		segments = append(segments, m.style("slice", center(truncate(label, segmentWidth), segmentWidth)))
	}
	return separator + strings.Join(segments, separator) + separator
}

func (m Model) panel(content string, width int) string {
	if m.noColor {
		return content
	}
	return lipgloss.NewStyle().Width(width).Padding(1).Border(lipgloss.RoundedBorder()).BorderForeground(lipgloss.Color("#2a3738")).Render(content)
}

func (m Model) style(kind, value string) string {
	if m.noColor {
		return value
	}
	style := lipgloss.NewStyle()
	switch kind {
	case "title":
		style = style.Bold(true).Foreground(lipgloss.Color("#061413")).Background(lipgloss.Color("#4ed6c2"))
	case "section", "gpu":
		style = style.Bold(true).Foreground(lipgloss.Color("#dfe9e7"))
	case "good", "slice":
		style = style.Foreground(lipgloss.Color("#4ed6c2"))
	case "warn":
		style = style.Foreground(lipgloss.Color("#e8b86b"))
	case "error":
		style = style.Foreground(lipgloss.Color("#f07178"))
	case "muted":
		style = style.Foreground(lipgloss.Color("#7f918f"))
	case "selected":
		style = style.Bold(true).Foreground(lipgloss.Color("#061413")).Background(lipgloss.Color("#4ed6c2"))
	case "tab":
		style = style.Bold(true).Foreground(lipgloss.Color("#4ed6c2")).Underline(true)
	case "search":
		style = style.Foreground(lipgloss.Color("#4ed6c2"))
	}
	return style.Render(value)
}

func (m Model) dash() string {
	if m.ascii {
		return "-"
	}
	return "—"
}

func metricRow(label string, metric model.Metric, dash string) string {
	return fmt.Sprintf("%-14s %-20s  %s / %s", label, render.Metric(metric, dash), metric.Source, metric.Scope)
}

func processLine(process model.Process, width int) string {
	identity := process.Executable
	if process.CommandLine != "" {
		identity = process.CommandLine
	}
	line := fmt.Sprintf("%-7d %-10s %s", process.PID, truncate(process.User, 10), identity)
	if process.Status != model.StatusAvailable {
		line += " [" + string(process.Status) + "]"
	}
	return truncate(line, width-2)
}

func matchesProcess(process model.Process, query string) bool {
	if query == "" {
		return true
	}
	parts := []string{strconv.FormatUint(uint64(process.PID), 10), process.User, process.Executable}
	return strings.Contains(strings.ToLower(strings.Join(parts, " ")), query)
}

func shortUUID(value string) string {
	if len(value) <= 18 {
		return value
	}
	return value[:10] + "…" + value[len(value)-6:]
}

func sparkline(values []float64, width int, ascii bool) string {
	if len(values) == 0 {
		return strings.Repeat("·", min(width, 12))
	}
	blocks := []rune("▁▂▃▄▅▆▇█")
	if ascii {
		blocks = []rune("._-~=+*#")
	}
	if len(values) > width {
		values = values[len(values)-width:]
	}
	var builder strings.Builder
	for _, value := range values {
		index := int(mathClamp(value, 0, 100) / 100 * float64(len(blocks)-1))
		builder.WriteRune(blocks[index])
	}
	return builder.String()
}

func mathClamp(value, low, high float64) float64 {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func truncate(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if lipgloss.Width(value) <= width {
		return value
	}
	if width == 1 {
		return "…"
	}
	runes := []rune(value)
	for len(runes) > 0 && lipgloss.Width(string(runes))+1 > width {
		runes = runes[:len(runes)-1]
	}
	return string(runes) + "…"
}

func wrap(value string, width int) string {
	if lipgloss.Width(value) <= width {
		return value
	}
	words := strings.Fields(value)
	lines, current := []string{}, ""
	for _, word := range words {
		if current != "" && lipgloss.Width(current)+1+lipgloss.Width(word) > width {
			lines = append(lines, current)
			current = word
		} else if current == "" {
			current = word
		} else {
			current += " " + word
		}
	}
	if current != "" {
		lines = append(lines, current)
	}
	return strings.Join(lines, "\n")
}

func center(value string, width int) string {
	gap := max(0, width-lipgloss.Width(value))
	left := gap / 2
	return strings.Repeat(" ", left) + value + strings.Repeat(" ", gap-left)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
