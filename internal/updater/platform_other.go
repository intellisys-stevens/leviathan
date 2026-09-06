//go:build !linux && !darwin

package updater

import "os"

func openNoFollow(string, int, os.FileMode) (*os.File, error) { return nil, ErrConfiguration }
func ownedByCurrentUserOrRoot(os.FileInfo) bool               { return false }
func lockState(string) (func(), error)                        { return nil, ErrConfiguration }
func availableBytes(string) (uint64, error)                   { return 0, ErrConfiguration }
