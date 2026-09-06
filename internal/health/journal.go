package health

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const maximumJournalBytes = 2 << 20

type journal struct {
	directory *os.File
	lock      *os.File
	file      *os.File
	date      string
	prunedDay string
	// Test seam for a failed durability barrier.
	syncFile func(*os.File) error
}

func openJournal(directory string, now time.Time) (*journal, []record, string, error) {
	if !filepath.IsAbs(directory) {
		return nil, nil, "", errors.New("health directory must be absolute")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, nil, "", fmt.Errorf("create health directory: %w", err)
	}
	fd, err := unix.Open(directory, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, "", fmt.Errorf("open health directory: %w", err)
	}
	dir := os.NewFile(uintptr(fd), directory)
	j := &journal{directory: dir, syncFile: func(file *os.File) error { return file.Sync() }}
	fail := func(err error) (*journal, []record, string, error) { _ = j.close(); return nil, nil, "", err }
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return fail(err)
	}
	if stat.Uid != uint32(os.Geteuid()) || stat.Mode&0o077 != 0 {
		return fail(errors.New("health directory must be owned by this user and private (0700)"))
	}
	j.lock, err = j.openFile("writer.lock", unix.O_RDWR|unix.O_CREAT)
	if err != nil {
		return fail(err)
	}
	if err := unix.Flock(int(j.lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fail(errors.New("another monitor owns the health journal"))
	}
	entries, warning, err := j.load(now)
	if err != nil {
		return fail(err)
	}
	if err := j.prune(firstDay(now)); err != nil {
		warning = "History retention cleanup failed: " + err.Error()
	}
	return j, entries, warning, nil
}

func (j *journal) openFile(name string, flags int) (*os.File, error) {
	fd, err := unix.Openat(int(j.directory.Fd()), name, flags|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open health journal file: %w", err)
	}
	file := os.NewFile(uintptr(fd), name)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		_ = file.Close()
		return nil, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Uid != uint32(os.Geteuid()) || stat.Mode&0o077 != 0 || stat.Nlink != 1 {
		_ = file.Close()
		return nil, errors.New("health journal files must be private, regular, single-link files owned by this user")
	}
	return file, nil
}

func journalDate(name string) (time.Time, bool) {
	if !strings.HasSuffix(name, ".ndjson") {
		return time.Time{}, false
	}
	date, err := time.Parse(time.DateOnly, strings.TrimSuffix(name, ".ndjson"))
	return date, err == nil
}

func (j *journal) filenames() ([]os.DirEntry, error) {
	// Reopening relative to the held directory also resets the read offset.
	fd, err := unix.Openat(int(j.directory.Fd()), ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), "health journal directory")
	defer file.Close()
	return file.ReadDir(-1)
}

func (j *journal) load(now time.Time) ([]record, string, error) {
	files, err := j.filenames()
	if err != nil {
		return nil, "", err
	}
	entries := make([]record, 0)
	warning := ""
	cutoff := firstDay(now)
	loadedFiles := 0
	for _, entry := range files {
		date, ok := journalDate(entry.Name())
		if !ok || date.Before(cutoff) {
			continue
		}
		loadedFiles++
		if loadedFiles > RetentionDays+2 {
			return nil, warning, errors.New("too many retained health journal files; existing files preserved")
		}
		file, err := j.openFile(entry.Name(), unix.O_RDWR)
		if err != nil {
			return nil, warning, err
		}
		data, readErr := io.ReadAll(io.LimitReader(file, maximumJournalBytes+1))
		if readErr != nil || len(data) > maximumJournalBytes {
			_ = file.Close()
			return nil, warning, errors.New("health journal exceeds its bounded size or cannot be read")
		}
		truncateTo := int64(-1)
		if len(data) > 0 && data[len(data)-1] != '\n' {
			end := bytes.LastIndexByte(data, '\n') + 1
			truncateTo = int64(end)
			data = data[:end]
			warning = "Recovered an incomplete final health observation."
		}
		seen := make(map[int64]struct{}, 1440)
		for _, line := range bytes.Split(data, []byte{'\n'}) {
			if len(line) == 0 {
				continue
			}
			var value record
			if err := json.Unmarshal(line, &value); err != nil {
				warning = "Some saved health observations are unreadable; those minutes remain unknown."
				continue
			}
			if value.Version != 1 {
				_ = file.Close()
				return nil, warning, errors.New("unsupported health journal version; existing files preserved")
			}
			if !validRecord(value) || value.ObservedAt.UTC().Format(time.DateOnly) != date.Format(time.DateOnly) {
				warning = "Some saved health observations are invalid; those minutes remain unknown."
				continue
			}
			if _, duplicate := seen[value.Minute]; duplicate {
				continue
			}
			seen[value.Minute] = struct{}{}
			if value.ObservedAt.After(now) {
				warning = "Saved observations have future timestamps; current coverage excludes them until that time."
			}
			entries = append(entries, value)
		}
		if truncateTo >= 0 {
			if err := file.Truncate(truncateTo); err != nil {
				_ = file.Close()
				return nil, warning, err
			}
			if err := j.syncFile(file); err != nil {
				_ = file.Close()
				return nil, warning, err
			}
		}
		_ = file.Close()
	}
	return entries, warning, nil
}

func validRecord(value record) bool {
	if value.ObservedAt.IsZero() || value.Minute != value.ObservedAt.Unix()/60 || len(value.Components) < 2 || len(value.Components) > 3 {
		return false
	}
	if _, ok := value.Components["system"]; !ok {
		return false
	}
	if _, ok := value.Components["gpu"]; !ok {
		return false
	}
	for id, state := range value.Components {
		if id != "system" && id != "gpu" && id != "attribution" {
			return false
		}
		switch state {
		case Operational, Degraded, Unavailable, Unsupported, Unknown:
		default:
			return false
		}
	}
	return true
}

func (j *journal) append(value record) error {
	date := value.ObservedAt.UTC().Format(time.DateOnly)
	if j.file == nil || j.date != date {
		if j.file != nil {
			if err := j.file.Close(); err != nil {
				return err
			}
			j.file = nil
		}
		file, err := j.openFile(date+".ndjson", unix.O_WRONLY|unix.O_APPEND|unix.O_CREAT)
		if err != nil {
			return err
		}
		j.file, j.date = file, date
		if err := j.directory.Sync(); err != nil {
			return err
		}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	n, err := j.file.Write(data)
	if err != nil {
		return err
	}
	if n != len(data) {
		return io.ErrShortWrite
	}
	return j.syncFile(j.file)
}

func (j *journal) prune(cutoff time.Time) error {
	day := cutoff.Format(time.DateOnly)
	if j.prunedDay == day {
		return nil
	}
	files, err := j.filenames()
	if err != nil {
		return err
	}
	for _, entry := range files {
		date, ok := journalDate(entry.Name())
		if !ok || !date.Before(cutoff) {
			continue
		}
		// Validate ownership, type and link count before removing only our
		// own expired files. Unrelated files are never touched.
		file, err := j.openFile(entry.Name(), unix.O_RDONLY)
		if err != nil {
			return err
		}
		_ = file.Close()
		if err := unix.Unlinkat(int(j.directory.Fd()), entry.Name(), 0); err != nil {
			return err
		}
	}
	if err := j.directory.Sync(); err != nil {
		return err
	}
	j.prunedDay = day
	return nil
}

func (j *journal) close() error {
	var errs []error
	if j.file != nil {
		errs = append(errs, j.syncFile(j.file), j.file.Close())
		j.file = nil
	}
	if j.lock != nil {
		errs = append(errs, j.lock.Close())
		j.lock = nil
	}
	if j.directory != nil {
		errs = append(errs, j.directory.Close())
		j.directory = nil
	}
	return errors.Join(errs...)
}
