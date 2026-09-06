package workload

import (
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var deviceNumber = regexp.MustCompile(`^[0-9]{1,10}:[0-9]{1,10}$`)

type ioCounter struct {
	read, write uint64
	leaves      []string
	partitionOf string
}

// readIO chooses one accounting layer. Complete physical leaf counters take
// precedence over mapper totals; partitions are ignored when their complete
// parent disk counter exists. Ambiguous overlaps are unavailable, not sums.
func readIO(data []byte, sysfs string, captured ...map[string]ioCounter) (uint64, uint64, string, error) {
	root, err := os.OpenRoot(sysfs)
	if err != nil {
		return 0, 0, "", err
	}
	defer root.Close()
	counters := map[string]ioCounter{}
	graphBudget := 8192
	for line := range strings.Lines(string(data)) {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if !deviceNumber.MatchString(fields[0]) || len(counters) >= 1024 {
			return 0, 0, "", errors.New("invalid storage counters")
		}
		if _, exists := counters[fields[0]]; exists {
			return 0, 0, "", errors.New("duplicate storage device")
		}
		values := map[string]uint64{}
		for _, field := range fields[1:] {
			pair := strings.SplitN(field, "=", 2)
			if len(pair) != 2 {
				return 0, 0, "", errors.New("invalid storage counter")
			}
			if pair[0] != "rbytes" && pair[0] != "wbytes" {
				continue
			}
			if _, duplicate := values[pair[0]]; duplicate {
				return 0, 0, "", errors.New("duplicate storage counter")
			}
			value, err := strconv.ParseUint(pair[1], 10, 64)
			if err != nil {
				return 0, 0, "", err
			}
			values[pair[0]] = value
		}
		read, hasRead := values["rbytes"]
		write, hasWrite := values["wbytes"]
		if !hasRead || !hasWrite {
			return 0, 0, "", errors.New("storage byte counters unavailable")
		}
		leaves, partition, err := backingDevices(root, sysfs, fields[0], map[string]bool{}, 0, &graphBudget)
		if err != nil {
			return 0, 0, "", err
		}
		counters[fields[0]] = ioCounter{read: read, write: write, leaves: leaves, partitionOf: partition}
	}
	selected := map[string]ioCounter{}
	for _, id := range sortedKeys(counters) {
		counter := counters[id]
		if counter.partitionOf != "" {
			if _, whole := counters[counter.partitionOf]; whole {
				continue
			}
		}
		if len(counter.leaves) > 1 || len(counter.leaves) == 1 && counter.leaves[0] != id && counter.partitionOf == "" {
			present := 0
			for _, leaf := range counter.leaves {
				if leafCounter, ok := counters[leaf]; ok && leafCounter.partitionOf == "" && len(leafCounter.leaves) == 1 && leafCounter.leaves[0] == leaf {
					present++
				}
			}
			if present == len(counter.leaves) {
				continue
			}
			if present > 0 {
				return 0, 0, "", errors.New("incomplete backing-device accounting layer")
			}
		}
		selected[id] = counter
	}
	seenLeaves := map[string]string{}
	var read, write uint64
	signature := []string{}
	for _, id := range sortedKeys(selected) {
		counter := selected[id]
		if len(captured) > 0 {
			captured[0][id] = counter
		}
		for _, leaf := range counter.leaves {
			if prior, exists := seenLeaves[leaf]; exists {
				// Distinct sibling partitions report disjoint byte ranges. Every
				// other overlapping backing graph is ambiguous without block traces.
				if counter.partitionOf == "" || selected[prior].partitionOf != counter.partitionOf {
					return 0, 0, "", errors.New("overlapping storage accounting layers")
				}
			}
			seenLeaves[leaf] = id
		}
		if math.MaxUint64-read < counter.read || math.MaxUint64-write < counter.write {
			return 0, 0, "", errors.New("storage counter overflow")
		}
		read += counter.read
		write += counter.write
		generations := []string{}
		for _, leaf := range counter.leaves {
			generation, err := deviceGeneration(root, sysfs, leaf)
			if err != nil {
				return 0, 0, "", err
			}
			generations = append(generations, generation)
		}
		signature = append(signature, id+"="+strings.Join(counter.leaves, ",")+"/"+counter.partitionOf+"/"+strings.Join(generations, ","))
	}
	return read, write, strings.Join(signature, ";"), nil
}

func deviceGeneration(root *os.Root, sysfs, id string) (string, error) {
	path, err := filepath.EvalSymlinks(filepath.Join(sysfs, "dev/block", id))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(sysfs, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, "../") {
		return "", errors.New("invalid physical device path")
	}
	data, err := readBounded(root, filepath.Join(relative, "diskseq"), 128)
	if err == nil {
		value, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
		if err != nil {
			return "", err
		}
		return relative + "#" + strconv.FormatUint(value, 10), nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	// Older kernels lack diskseq. Canonical path plus directory modification
	// generation detects replacement without exposing hardware serial numbers.
	info, err := root.Stat(relative)
	if err != nil {
		return "", err
	}
	return relative + "#" + strconv.FormatInt(info.ModTime().UnixNano(), 10), nil
}

func backingDevices(root *os.Root, sysfs, id string, visiting map[string]bool, depth int, budget *int) ([]string, string, error) {
	(*budget)--
	if *budget < 0 || depth > 16 || visiting[id] || !deviceNumber.MatchString(id) {
		return nil, "", errors.New("invalid backing-device graph")
	}
	visiting[id] = true
	defer delete(visiting, id)
	path, err := filepath.EvalSymlinks(filepath.Join(sysfs, "dev/block", id))
	if err != nil {
		return nil, "", err
	}
	relative, err := filepath.Rel(sysfs, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, "", errors.New("backing device escapes sysfs")
	}
	if _, err := root.Stat(filepath.Join(relative, "partition")); err == nil {
		data, err := readBounded(root, filepath.Join(filepath.Dir(relative), "dev"), 128)
		if err != nil {
			return nil, "", err
		}
		parent := strings.TrimSpace(string(data))
		leaves, _, err := backingDevices(root, sysfs, parent, visiting, depth+1, budget)
		return leaves, parent, err
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, "", err
	}
	directory, err := root.Open(filepath.Join(relative, "slaves"))
	if err != nil {
		return nil, "", err
	}
	entries, err := directory.ReadDir(1025)
	directory.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, "", err
	}
	if len(entries) > 1024 {
		return nil, "", errors.New("backing device graph exceeds bound")
	}
	if len(entries) == 0 {
		if strings.HasPrefix(relative, "devices/virtual/") {
			return nil, "", errors.New("virtual storage has no known physical backing")
		}
		return []string{id}, "", nil
	}
	leaves := map[string]bool{}
	for _, entry := range entries {
		data, err := readBounded(root, filepath.Join(relative, "slaves", entry.Name(), "dev"), 128)
		if err != nil {
			return nil, "", err
		}
		child := strings.TrimSpace(string(data))
		resolved, _, err := backingDevices(root, sysfs, child, visiting, depth+1, budget)
		if err != nil {
			return nil, "", fmt.Errorf("incomplete backing graph: %w", err)
		}
		for _, leaf := range resolved {
			leaves[leaf] = true
		}
	}
	result := make([]string, 0, len(leaves))
	for leaf := range leaves {
		result = append(result, leaf)
	}
	sort.Strings(result)
	return result, "", nil
}
