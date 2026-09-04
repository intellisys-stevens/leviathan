package render

import (
	"fmt"
	"io"
	"text/tabwriter"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

func SnapshotTable(writer io.Writer, snapshot model.Snapshot, ascii bool) {
	dash := "—"
	branch, lastBranch := "├─", "└─"
	if ascii {
		dash, branch, lastBranch = "-", "+-", "\\-"
	}
	output := tabwriter.NewWriter(writer, 0, 4, 2, ' ', 0)
	fmt.Fprintf(output, "Leviathan\t%s\t%s\tsequence %d\n", snapshot.Host.Hostname, snapshot.SampledAt.Format(time.RFC3339), snapshot.Sequence)
	fmt.Fprintln(output, "MACHINE\tVALUE\tDETAIL\tSOURCE\tSTATUS")
	fmt.Fprintf(output, "CPU\t%s\t%d logical; load %s / %s / %s\t%s\t%s\n",
		Metric(snapshot.System.CPU.Utilization, dash), snapshot.System.CPU.LogicalProcessors,
		Metric(snapshot.System.CPU.Load1, dash), Metric(snapshot.System.CPU.Load5, dash), Metric(snapshot.System.CPU.Load15, dash),
		snapshot.System.CPU.Source, statusLabel(snapshot.System.CPU.Status))
	fmt.Fprintf(output, "RAM\t%s\tavailable %s\t%s\t%s\n", SystemMemory(snapshot.System.Memory, dash), BytesPointer(snapshot.System.Memory.AvailableBytes, dash), snapshot.System.Memory.Source, statusLabel(snapshot.System.Memory.Status))
	fmt.Fprintf(output, "Storage\t%s\tread %s; write %s\t%s\t%s\n", StorageCapacity(snapshot.System.Storage, dash), Metric(snapshot.System.Storage.ReadBytesPerSecond, dash), Metric(snapshot.System.Storage.WriteBytesPerSecond, dash), snapshot.System.Storage.Source, statusLabel(snapshot.System.Storage.Status))
	for _, filesystem := range snapshot.System.Storage.Filesystems {
		fmt.Fprintf(output, "Filesystem %s\t%s\t%s\t%s\t%s\n", filesystem.MountPoint, FilesystemCapacity(filesystem, dash), filesystem.FSType, filesystem.Source, statusLabel(filesystem.Status))
	}
	fmt.Fprintln(output)
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

func DoctorText(writer io.Writer, checkedAt time.Time, status string, diagnostics []model.Diagnostic) {
	output := tabwriter.NewWriter(writer, 0, 4, 2, ' ', 0)
	fmt.Fprintf(output, "Leviathan doctor\t%s\t%s\n", checkedAt.Format(time.RFC3339), status)
	fmt.Fprintln(output, "STATUS\tCOMPONENT\tCHECK\tDETAIL")
	for _, diagnostic := range diagnostics {
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
	if !usableStatus(metric.Status) || metric.Value == nil {
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
	case "bytes_per_second", "bytes/second":
		if *metric.Value < 0 {
			return dash
		}
		return Bytes(uint64(*metric.Value)) + "/s"
	case "load":
		return fmt.Sprintf("%.2f", *metric.Value)
	default:
		return fmt.Sprintf("%.2f %s", *metric.Value, metric.Unit)
	}
}

func SystemMemory(memory model.SystemMemory, dash string) string {
	return capacity(memory.UsedBytes, memory.TotalBytes, memory.Status, dash)
}

func StorageCapacity(storage model.Storage, dash string) string {
	return capacity(storage.UsedBytes, storage.TotalBytes, storage.Status, dash)
}

func FilesystemCapacity(filesystem model.Filesystem, dash string) string {
	return capacity(filesystem.UsedBytes, filesystem.TotalBytes, filesystem.Status, dash)
}

func capacity(used, total *uint64, status model.MetricStatus, dash string) string {
	totalLabel := BytesPointer(total, dash)
	if (!usableStatus(status) && status != model.StatusStale) || used == nil {
		return fmt.Sprintf("%s / %s (%s)", dash, totalLabel, statusLabel(status))
	}
	value := fmt.Sprintf("%s / %s", Bytes(*used), totalLabel)
	if status == model.StatusStale {
		value += " (stale)"
	}
	return value
}

func BytesPointer(value *uint64, dash string) string {
	if value == nil {
		return dash
	}
	return Bytes(*value)
}

func usableStatus(status model.MetricStatus) bool {
	return status == model.StatusAvailable || status == model.StatusEstimated
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
