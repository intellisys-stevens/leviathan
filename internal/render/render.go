package render

import (
	"fmt"
	"io"
	"text/tabwriter"
	"time"

	"github.com/miglens/miglens/internal/doctor"
	"github.com/miglens/miglens/internal/model"
)

func SnapshotTable(writer io.Writer, snapshot model.Snapshot, ascii bool) {
	dash := "—"
	branch, lastBranch := "├─", "└─"
	if ascii {
		dash, branch, lastBranch = "-", "+-", "\\-"
	}
	output := tabwriter.NewWriter(writer, 0, 4, 2, ' ', 0)
	fmt.Fprintf(output, "MIGLens\t%s\t%s\tsequence %d\n", snapshot.Host.Hostname, snapshot.SampledAt.Format(time.RFC3339), snapshot.Sequence)
	fmt.Fprintln(output, "ENTITY\tPROFILE\tMEMORY\tSM\tSTATUS")
	if len(snapshot.GPUs) == 0 {
		fmt.Fprintf(output, "%s\t%s\t%s\t%s\t%s\n", "No NVIDIA GPUs", dash, dash, dash, "unsupported")
	}
	for _, gpu := range snapshot.GPUs {
		fmt.Fprintf(output, "GPU %d  %s\tphysical\t%s\t%s\t%s\n", gpu.Index, gpu.Name, Memory(gpu.Memory, dash), Metric(gpu.Metrics["sm_activity"], dash), statusLabel(gpu.Memory.Status))
		for giIndex, gi := range gpu.GPUInstances {
			prefix := branch
			if giIndex == len(gpu.GPUInstances)-1 {
				prefix = lastBranch
			}
			fmt.Fprintf(output, "%s GI %d\t%s\t%s\t%s\t%s\n", prefix, gi.ID, gi.Profile, Memory(gi.Memory, dash), Metric(gi.Metrics["sm_activity"], dash), statusLabel(dominantStatus(gi)))
			if len(gi.ComputeInstances) > 1 {
				for _, ci := range gi.ComputeInstances {
					fmt.Fprintf(output, "   %s CI %d\t%s\t%s\t%s\t%s\n", branch, ci.ID, ci.Profile, "GI-scoped", "GI-scoped", "available")
				}
			}
		}
	}
	fmt.Fprintln(output, "\nGPU PROCESSES\tUSER\tEXECUTABLE\tCOMMAND\tSTARTED\tSTATUS")
	if len(snapshot.Processes) == 0 {
		fmt.Fprintf(output, "No GPU-connected processes in the current PID namespace\t%s\t%s\t%s\t%s\t%s\n", dash, dash, dash, dash, statusLabel(snapshot.Capabilities.Proc.Status))
	}
	for _, process := range snapshot.Processes {
		started := dash
		if process.StartTime != nil {
			started = process.StartTime.Format(time.RFC3339)
		}
		command := dash
		if process.CommandLine != "" {
			command = process.CommandLine
		}
		fmt.Fprintf(output, "%d\t%s\t%s\t%s\t%s\t%s\n", process.PID, valueOrDash(process.User, dash), valueOrDash(process.Executable, dash), command, started, statusLabel(process.Status))
	}
	if len(snapshot.Diagnostics) > 0 {
		fmt.Fprintln(output, "\nDIAGNOSTICS\tCOMPONENT\tSTATUS\tREMEDY")
		for _, diagnostic := range snapshot.Diagnostics {
			fmt.Fprintf(output, "%s\t%s\t%s\t%s\n", diagnostic.Summary, diagnostic.Component, diagnostic.Status, diagnostic.Remedy)
		}
	}
	_ = output.Flush()
}

func DoctorText(writer io.Writer, report doctor.Report) {
	output := tabwriter.NewWriter(writer, 0, 4, 2, ' ', 0)
	fmt.Fprintf(output, "MIGLens doctor\t%s\n", report.CheckedAt.Format(time.RFC3339))
	fmt.Fprintln(output, "STATUS\tCOMPONENT\tCHECK\tDETAIL")
	for _, diagnostic := range report.Diagnostics {
		detail := diagnostic.Detail
		if diagnostic.Remedy != "" {
			if detail != "" {
				detail += "; "
			}
			detail += "remedy: " + diagnostic.Remedy
		}
		fmt.Fprintf(output, "%s\t%s\t%s\t%s\n", diagnostic.Status, diagnostic.Component, diagnostic.Summary, detail)
	}
	_ = output.Flush()
}

func Metric(metric model.Metric, dash string) string {
	if metric.Status != model.StatusAvailable || metric.Value == nil {
		if metric.Status == "" {
			return dash
		}
		return dash + " (" + string(metric.Status) + ")"
	}
	switch metric.Unit {
	case "percent":
		return fmt.Sprintf("%.1f%%", *metric.Value)
	case "celsius":
		return fmt.Sprintf("%.0f°C", *metric.Value)
	case "watts":
		return fmt.Sprintf("%.0f W", *metric.Value)
	case "mhz":
		return fmt.Sprintf("%.0f MHz", *metric.Value)
	default:
		return fmt.Sprintf("%.2f %s", *metric.Value, metric.Unit)
	}
}

func Memory(memory model.Memory, dash string) string {
	total := dash
	if memory.TotalBytes != nil {
		total = Bytes(*memory.TotalBytes)
	}
	if memory.Status != model.StatusAvailable || memory.UsedBytes == nil {
		return fmt.Sprintf("%s / %s (%s)", dash, total, memory.Status)
	}
	return fmt.Sprintf("%s / %s", Bytes(*memory.UsedBytes), total)
}

func Bytes(value uint64) string {
	const (
		kiB = 1024
		miB = 1024 * kiB
		giB = 1024 * miB
	)
	switch {
	case value >= giB:
		return fmt.Sprintf("%.1f GiB", float64(value)/giB)
	case value >= miB:
		return fmt.Sprintf("%.0f MiB", float64(value)/miB)
	case value >= kiB:
		return fmt.Sprintf("%.0f KiB", float64(value)/kiB)
	default:
		return fmt.Sprintf("%d B", value)
	}
}

func dominantStatus(instance model.GPUInstance) model.MetricStatus {
	if metric, ok := instance.Metrics["sm_activity"]; ok && metric.Status != model.StatusAvailable {
		return metric.Status
	}
	return instance.Memory.Status
}

func statusLabel(status model.MetricStatus) string {
	if status == "" {
		return "available"
	}
	return string(status)
}

func valueOrDash(value, dash string) string {
	if value == "" {
		return dash
	}
	return value
}
