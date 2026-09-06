package health

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sys/unix"
)

const uplinkQueueSize = 8

type uplinkRecord struct {
	Version    int       `json:"version"`
	ObservedAt time.Time `json:"observedAt"`
	Minute     int64     `json:"minute"`
	State      State     `json:"state"`
}

// Uplink records have their own namespace and version. Previous builds ignore
// these filenames and continue to read their unchanged legacy journal schema.
type uplinkJournal struct{ io *journal }

func openUplinkJournal(owner *journal, now time.Time) (*uplinkJournal, []uplinkRecord, string, error) {
	// Hold an independent directory descriptor and file cursor, while the
	// recorder retains the existing lifetime writer.lock ownership for both.
	fd, err := unix.Openat(int(owner.directory.Fd()), ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, "", err
	}
	j := &uplinkJournal{io: &journal{directory: os.NewFile(uintptr(fd), "uplink history directory"), syncFile: func(file *os.File) error { return file.Sync() }}}
	entries, warning, err := j.load(now)
	if err != nil {
		_ = j.io.close()
		return nil, nil, warning, err
	}
	if err := j.prune(firstDay(now)); err != nil {
		warning = "Yggdrasil history retention cleanup failed: " + err.Error()
	}
	return j, entries, warning, nil
}

func uplinkJournalDate(name string) (time.Time, bool) {
	if !strings.HasPrefix(name, "uplink-") {
		return time.Time{}, false
	}
	return journalDate(strings.TrimPrefix(name, "uplink-"))
}

func validUplinkRecord(value uplinkRecord) bool {
	if value.ObservedAt.IsZero() || value.Minute != value.ObservedAt.Unix()/60 {
		return false
	}
	switch value.State {
	case Operational, Degraded, Unavailable, Unsupported, Unknown:
		return true
	default:
		return false
	}
}

func (j *uplinkJournal) load(now time.Time) ([]uplinkRecord, string, error) {
	files, err := j.io.filenames()
	if err != nil {
		return nil, "", err
	}
	entries := make([]uplinkRecord, 0)
	warning := ""
	cutoff := firstDay(now)
	loadedFiles := 0
	for _, entry := range files {
		date, ok := uplinkJournalDate(entry.Name())
		if !ok || date.Before(cutoff) {
			continue
		}
		loadedFiles++
		if loadedFiles > RetentionDays+2 {
			return nil, warning, errors.New("too many retained Yggdrasil journal files; existing files preserved")
		}
		file, err := j.io.openFile(entry.Name(), unix.O_RDWR)
		if err != nil {
			return nil, warning, err
		}
		data, readErr := io.ReadAll(io.LimitReader(file, maximumJournalBytes+1))
		if readErr != nil || len(data) > maximumJournalBytes {
			_ = file.Close()
			return nil, warning, errors.New("Yggdrasil journal exceeds its bounded size or cannot be read")
		}
		truncateTo := int64(-1)
		if len(data) > 0 && data[len(data)-1] != '\n' {
			end := bytes.LastIndexByte(data, '\n') + 1
			truncateTo = int64(end)
			data = data[:end]
			warning = "Recovered an incomplete final Yggdrasil observation."
		}
		seen := make(map[int64]struct{}, 1440)
		for _, line := range bytes.Split(data, []byte{'\n'}) {
			if len(line) == 0 {
				continue
			}
			var value uplinkRecord
			if err := json.Unmarshal(line, &value); err != nil {
				warning = "Some saved Yggdrasil observations are unreadable; those minutes remain unknown."
				continue
			}
			if value.Version != 1 {
				_ = file.Close()
				return nil, warning, errors.New("unsupported Yggdrasil journal version; existing files preserved")
			}
			if !validUplinkRecord(value) || value.ObservedAt.UTC().Format(time.DateOnly) != date.Format(time.DateOnly) {
				warning = "Some saved Yggdrasil observations are invalid; those minutes remain unknown."
				continue
			}
			if _, duplicate := seen[value.Minute]; duplicate {
				continue
			}
			seen[value.Minute] = struct{}{}
			if value.ObservedAt.After(now) {
				warning = "Saved Yggdrasil observations have future timestamps; current coverage excludes them until that time."
			}
			entries = append(entries, value)
		}
		if truncateTo >= 0 {
			if err := file.Truncate(truncateTo); err != nil {
				_ = file.Close()
				return nil, warning, err
			}
			if err := j.io.syncFile(file); err != nil {
				_ = file.Close()
				return nil, warning, err
			}
		}
		_ = file.Close()
	}
	return entries, warning, nil
}

func (j *uplinkJournal) append(value uplinkRecord) error {
	date := value.ObservedAt.UTC().Format(time.DateOnly)
	if j.io.file == nil || j.io.date != date {
		if j.io.file != nil {
			if err := j.io.file.Close(); err != nil {
				return err
			}
			j.io.file = nil
		}
		file, err := j.io.openFile("uplink-"+date+".ndjson", unix.O_WRONLY|unix.O_APPEND|unix.O_CREAT)
		if err != nil {
			return err
		}
		j.io.file, j.io.date = file, date
		if err := j.io.directory.Sync(); err != nil {
			return err
		}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	n, err := j.io.file.Write(data)
	if err != nil {
		return err
	}
	if n != len(data) {
		return io.ErrShortWrite
	}
	return j.io.syncFile(j.io.file)
}

func (j *uplinkJournal) prune(cutoff time.Time) error {
	day := cutoff.Format(time.DateOnly)
	if j.io.prunedDay == day {
		return nil
	}
	files, err := j.io.filenames()
	if err != nil {
		return err
	}
	for _, entry := range files {
		date, ok := uplinkJournalDate(entry.Name())
		if !ok || !date.Before(cutoff) {
			continue
		}
		file, err := j.io.openFile(entry.Name(), unix.O_RDONLY)
		if err != nil {
			return err
		}
		_ = file.Close()
		if err := unix.Unlinkat(int(j.io.directory.Fd()), entry.Name(), 0); err != nil {
			return err
		}
	}
	if err := j.io.directory.Sync(); err != nil {
		return err
	}
	j.io.prunedDay = day
	return nil
}

// uplinkWriter never shares the legacy journal's write mutex or its file.
// A bounded, nonblocking queue isolates disk latency from minute observations.
// A failed write or full queue disables saving only this sidecar until restart.
type uplinkWriter struct {
	journal *uplinkJournal
	queue   chan uplinkRecord
	done    chan struct{}
	failed  atomic.Bool
	report  func(bool, string)
	close   sync.Once
	err     error
}

func newUplinkWriter(j *uplinkJournal, report func(bool, string)) *uplinkWriter {
	w := &uplinkWriter{journal: j, queue: make(chan uplinkRecord, uplinkQueueSize), done: make(chan struct{}), report: report}
	go w.run()
	return w
}

func (w *uplinkWriter) fail(message string) {
	if w.failed.CompareAndSwap(false, true) {
		w.report(false, "Yggdrasil history not being saved: "+message)
	}
}

func (w *uplinkWriter) enqueue(entry uplinkRecord) {
	if w.failed.Load() {
		return
	}
	select {
	case w.queue <- entry:
	default:
		w.fail("the disk writer queue is full; live observations continue in memory.")
	}
}

func (w *uplinkWriter) run() {
	defer close(w.done)
	for entry := range w.queue {
		if w.failed.Load() {
			continue
		}
		if err := w.journal.append(entry); err != nil {
			w.fail(err.Error())
			continue
		}
		if err := w.journal.prune(firstDay(entry.ObservedAt)); err != nil && !w.failed.Load() {
			w.report(true, "Yggdrasil history retention cleanup failed: "+err.Error())
		}
	}
	w.err = w.journal.io.close()
}

func (w *uplinkWriter) shutdown() error {
	w.close.Do(func() { close(w.queue) })
	<-w.done
	return w.err
}
