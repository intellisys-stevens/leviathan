// Package scope maps Kubernetes Pod cgroups to stable opaque execution scopes.
package scope

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"path/filepath"
	"regexp"
	"strings"
)

var canonicalPodUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var podUIDInCgroup = regexp.MustCompile(`pod([[:xdigit:]]{8}[-_][[:xdigit:]]{4}[-_][[:xdigit:]]{4}[-_][[:xdigit:]]{4}[-_][[:xdigit:]]{12})`)
var podDirectory = regexp.MustCompile(`pod([[:xdigit:]]{8}[-_][[:xdigit:]]{4}[-_][[:xdigit:]]{4}[-_][[:xdigit:]]{4}[-_][[:xdigit:]]{12})(?:\.slice)?$`)

// ValidUID reports whether a Kubernetes UID uses the canonical UUID form.
func ValidUID(value string) bool { return canonicalPodUID.MatchString(value) }

func PodUID(value string) (string, bool) {
	value = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), "_", "-"))
	if !canonicalPodUID.MatchString(value) {
		return "", false
	}
	digest := sha256.Sum256([]byte("scope_\x00" + value))
	return "scope_" + hex.EncodeToString(digest[:16]), true
}

func FromCgroup(data string) (string, bool) {
	resolved := ""
	for _, line := range strings.Split(data, "\n") {
		fields := strings.SplitN(line, ":", 3)
		if len(fields) != 3 {
			continue
		}
		path := fields[2]
		for _, match := range podUIDInCgroup.FindAllStringSubmatchIndex(path, -1) {
			if len(match) != 4 || (match[0] > 0 && !cgroupPathBoundary(path[match[0]-1])) || (match[1] < len(path) && !cgroupPathBoundary(path[match[1]])) {
				continue
			}
			scopeRef, ok := PodUID(path[match[2]:match[3]])
			if !ok {
				continue
			}
			if resolved != "" && resolved != scopeRef {
				return "", false
			}
			resolved = scopeRef
		}
	}
	return resolved, resolved != ""
}

func cgroupPathBoundary(character byte) bool {
	return character == '/' || character == '_' || character == '.' || character == '-'
}

func DiscoverCgroups(ctx context.Context, root string) (map[string]string, error) {
	paths := map[string]string{}
	visited := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		visited++
		if visited > 32768 {
			return errors.New("cgroup discovery exceeds bound")
		}
		if !entry.IsDir() {
			return nil
		}
		match := podDirectory.FindStringSubmatch(entry.Name())
		if match == nil {
			return nil
		}
		scope, ok := PodUID(match[1])
		if !ok {
			return filepath.SkipDir
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if _, duplicate := paths[scope]; duplicate {
			paths[scope] = ""
		} else {
			paths[scope] = relative
		}
		return filepath.SkipDir
	})
	return paths, err
}
