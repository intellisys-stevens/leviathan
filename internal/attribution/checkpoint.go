package attribution

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"k8s.io/utils/dump"
)

const CheckpointMaxBytes = 8 << 20
const checkpointInterval = 2 * time.Second

type preparedBinding struct {
	ClaimRef   string
	ParentUUID string
	GIID, CIID uint32
	MIGUUID    string
	Epoch      uint64
}

type checkpointObservation struct {
	Entries     map[string]preparedBinding
	ObservedAt  time.Time
	Revision    uint64
	Reason      string
	fingerprint string
}

// CheckpointReader is an independent read-only worker. Slow or failed disk reads
// never run on the GPU sampling path. Errors invalidate identity coverage at once.
type CheckpointReader struct {
	mu        sync.RWMutex
	current   checkpointObservation
	nextEpoch uint64
	last      map[string]preparedBinding
	read      func() (map[string]preparedBinding, string, error)
	cancel    context.CancelFunc
	done      chan struct{}
}

func NewCheckpointReader(path string) *CheckpointReader {
	r := &CheckpointReader{last: map[string]preparedBinding{}, current: checkpointObservation{Entries: map[string]preparedBinding{}, Reason: "checkpoint_unavailable"}}
	r.read = func() (map[string]preparedBinding, string, error) {
		boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
		if err != nil {
			return nil, "", errors.New("checkpoint_unavailable")
		}
		return readCheckpointFile(path, strings.TrimSpace(string(boot)), 0)
	}
	return r
}

func (r *CheckpointReader) Start(parent context.Context) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	r.cancel, r.done = cancel, make(chan struct{})
	go func() {
		defer close(r.done)
		r.Poll(time.Now())
		ticker := time.NewTicker(checkpointInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case at := <-ticker.C:
				r.Poll(at)
			}
		}
	}()
}

func (r *CheckpointReader) Close() {
	r.mu.RLock()
	cancel, done := r.cancel, r.done
	r.mu.RUnlock()
	if cancel != nil {
		cancel()
		// A blocked host filesystem must not prevent monitor shutdown.
		select {
		case <-done:
		case <-time.After(time.Second):
		}
	}
}

func (r *CheckpointReader) Poll(at time.Time) {
	entries, fingerprint, err := r.read()
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		reason := err.Error()
		if reason != "checkpoint_invalid" {
			reason = "checkpoint_unavailable"
		}
		if r.current.Reason != reason {
			r.current.Revision++
		}
		r.current.Reason = reason
		return
	}
	for ref, entry := range entries {
		old, active := r.last[ref]
		old.Epoch = 0
		if !active || old != entry {
			r.nextEpoch++
			entry.Epoch = r.nextEpoch
		} else {
			entry.Epoch = r.last[ref].Epoch
		}
		entries[ref] = entry
	}
	if fingerprint != r.current.fingerprint || r.current.Reason != "" {
		r.current.Revision++
	}
	r.last = entries
	r.current.Entries = entries
	r.current.ObservedAt = at
	r.current.Reason = ""
	r.current.fingerprint = fingerprint

}

func (r *CheckpointReader) Current(now time.Time) checkpointObservation {
	r.mu.RLock()
	out := r.current
	r.mu.RUnlock()
	if out.Reason == "" && (out.ObservedAt.IsZero() || now.Sub(out.ObservedAt) >= 15*time.Second || out.ObservedAt.After(now.Add(time.Minute))) {
		out.Reason = "checkpoint_stale"
	}
	return out
}

func readCheckpointFile(path, bootID string, ownerUID uint32) (map[string]preparedBinding, string, error) {
	for attempt := 0; attempt < 2; attempt++ {
		dir := filepath.Dir(path)
		resolved, err := filepath.EvalSymlinks(dir)
		if err != nil || resolved != dir {
			return nil, "", errors.New("checkpoint_unavailable")
		}
		fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if err != nil {
			return nil, "", errors.New("checkpoint_unavailable")
		}
		f := os.NewFile(uintptr(fd), path)
		before, statErr := f.Stat()
		if statErr != nil {
			f.Close()
			return nil, "", errors.New("checkpoint_unavailable")
		}
		stat, ok := before.Sys().(*syscall.Stat_t)
		if !before.Mode().IsRegular() || before.Mode().Perm()&022 != 0 || !ok || stat.Uid != ownerUID || before.Size() > CheckpointMaxBytes {
			f.Close()
			return nil, "", errors.New("checkpoint_invalid")
		}
		data, readErr := io.ReadAll(io.LimitReader(f, CheckpointMaxBytes+1))
		after, afterErr := f.Stat()
		f.Close()
		current, pathErr := os.Lstat(path)
		if readErr != nil {
			return nil, "", errors.New("checkpoint_unavailable")
		}
		if afterErr != nil || pathErr != nil || !os.SameFile(before, current) || before.Size() != after.Size() || before.ModTime() != after.ModTime() {
			continue
		}
		entries, err := parseCheckpoint(data, bootID)
		if err != nil {
			return nil, "", errors.New("checkpoint_invalid")
		}
		sum := sha256.Sum256(data)
		return entries, hex.EncodeToString(sum[:]), nil
	}
	return nil, "", errors.New("checkpoint_unavailable")
}

// Raw nested claims preserve NVIDIA's exact JSON checksum representation,
// including optional future nested fields. No upstream driver package is linked.
type checkpointV2 struct {
	Checksum       uint64          `json:"checksum"`
	PreparedClaims json.RawMessage `json:"preparedClaims,omitempty"`
	NodeBootID     string          `json:"nodeBootID,omitempty"`
}
type checkpointClaim struct {
	State  string `json:"checkpointState"`
	Status struct {
		Allocation *struct {
			Devices struct {
				Results []checkpointAllocation `json:"results"`
			} `json:"devices"`
		} `json:"allocation"`
	} `json:"status"`
	Groups []struct {
		Devices []struct {
			MIG *struct {
				Concrete *struct {
					ParentUUID string  `json:"parentUUID"`
					GIID       *uint32 `json:"giId"`
					CIID       *uint32 `json:"ciId"`
					MIGUUID    string  `json:"migUUID"`
				} `json:"concrete"`
				Device *struct {
					Requests []string `json:"Requests"`
					Pool     string   `json:"PoolName"`
					Name     string   `json:"DeviceName"`
				} `json:"device"`
			} `json:"mig"`
		} `json:"devices"`
	} `json:"preparedDevices"`
}
type checkpointAllocation struct {
	Request     string `json:"request"`
	Driver      string `json:"driver"`
	Pool        string `json:"pool"`
	Device      string `json:"device"`
	AdminAccess bool   `json:"adminAccess"`
	ShareID     string `json:"shareID"`
}

func checkpointChecksum(data []byte) uint64 {
	h := fnv.New32a()
	fmt.Fprint(h, dump.ForHash(data))
	return uint64(h.Sum32())
}

func parseCheckpoint(data []byte, bootID string) (map[string]preparedBinding, error) {
	invalid := errors.New("checkpoint_invalid")
	if len(data) > CheckpointMaxBytes || bootID == "" || !uniqueJSON(data) {
		return nil, invalid
	}
	var envelope struct {
		Checksum uint64          `json:"checksum"`
		V1       json.RawMessage `json:"v1"`
		V2       json.RawMessage `json:"v2"`
	}
	if err := strictDecode(data, &envelope); err != nil || len(envelope.V2) == 0 {
		return nil, invalid
	}
	var v2 checkpointV2
	if err := strictDecode(envelope.V2, &v2); err != nil || v2.NodeBootID != bootID {
		return nil, invalid
	}
	checksum := v2.Checksum
	v2.Checksum = 0
	encoded, err := json.Marshal(v2)
	if err != nil || checkpointChecksum(encoded) != checksum {
		return nil, invalid
	}
	claims := map[string]checkpointClaim{}
	if len(v2.PreparedClaims) != 0 {
		if err := json.Unmarshal(v2.PreparedClaims, &claims); err != nil {
			return nil, invalid
		}
	}
	if len(claims) > MaxWorkloads {
		return nil, invalid
	}
	out := map[string]preparedBinding{}
	preparedOwners := map[string]string{}
	for uid, claim := range claims {
		claimRef, valid := ClaimRef(uid)
		if !valid {
			return nil, invalid
		}
		if claim.State != "PrepareCompleted" {
			if claim.State != "PrepareStarted" && claim.State != "" {
				return nil, invalid
			}
			continue
		}
		if claim.Status.Allocation == nil {
			return nil, invalid
		}
		allocated := map[string]bool{}
		for _, a := range claim.Status.Allocation.Devices.Results {
			if a.Driver != "gpu.nvidia.com" || a.AdminAccess || a.ShareID != "" {
				continue
			}
			if !validDisplayString(a.Request, 253, false) || !validDisplayString(a.Pool, 253, false) || !validDisplayString(a.Device, 253, false) {
				return nil, invalid
			}
			ref := AllocationRef(uid, a.Request, a.Driver, a.Pool, a.Device)
			if allocated[ref] {
				return nil, invalid
			}
			allocated[ref] = true
		}
		for _, group := range claim.Groups {
			for _, entry := range group.Devices {
				m := entry.MIG
				if m == nil {
					continue
				}
				if m.Concrete == nil || m.Device == nil || len(m.Device.Requests) == 0 {
					return nil, invalid
				}
				c := m.Concrete
				if c.GIID == nil || c.CIID == nil || !strings.HasPrefix(c.ParentUUID, "GPU-") || !validDisplayString(c.ParentUUID, 128, false) ||
					!validDisplayString(c.MIGUUID, 128, false) || (!strings.HasPrefix(c.MIGUUID, "MIG-") && c.MIGUUID != c.ParentUUID) {
					return nil, invalid
				}
				binding := preparedBinding{ClaimRef: claimRef, ParentUUID: c.ParentUUID, GIID: *c.GIID, CIID: *c.CIID, MIGUUID: c.MIGUUID}
				tuple := tupleKey(c.ParentUUID, *c.GIID, *c.CIID)
				origin := strings.Join([]string{uid, m.Device.Pool, m.Device.Name}, "\x00")
				if previous, exists := preparedOwners[tuple]; exists && previous != origin {
					return nil, invalid
				}
				preparedOwners[tuple] = origin

				for _, request := range m.Device.Requests {
					ref := AllocationRef(uid, request, "gpu.nvidia.com", m.Device.Pool, m.Device.Name)
					if !allocated[ref] {
						return nil, invalid
					}
					if _, exists := out[ref]; exists {
						return nil, invalid
					}
					out[ref] = binding
				}
			}
		}
		if len(out) > MaxAssignments {
			return nil, invalid
		}
	}
	return out, nil
}

func strictDecode(data []byte, value any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return err
	}
	if err := d.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON")
	}
	return nil
}

// Refuse duplicate keys and excessive nesting before interpreting identifiers.
func uniqueJSON(data []byte) bool {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var value func(int) bool
	value = func(depth int) bool {
		if depth > 64 {
			return false
		}
		token, err := d.Token()
		if err != nil {
			return false
		}
		delim, container := token.(json.Delim)
		if !container {
			return true
		}
		switch delim {
		case '{':
			keys := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return false
				}
				name, ok := key.(string)
				if !ok || keys[name] {
					return false
				}
				keys[name] = true
				if !value(depth + 1) {
					return false
				}
			}
			end, err := d.Token()
			return err == nil && end == json.Delim('}')
		case '[':
			for d.More() {
				if !value(depth + 1) {
					return false
				}
			}
			end, err := d.Token()
			return err == nil && end == json.Delim(']')
		default:
			return false
		}
	}
	if !value(0) {
		return false
	}
	_, err := d.Token()
	return errors.Is(err, io.EOF)
}
