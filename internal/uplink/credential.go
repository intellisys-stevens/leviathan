package uplink

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
)

const (
	machineTokenPrefix      = "yv1_"
	machineLookupBytes      = 16
	machineSecretBytes      = 32
	machineLookupCharacters = 22
	machineSecretCharacters = 43
	machineTokenLength      = len(machineTokenPrefix) + machineLookupCharacters + 1 + machineSecretCharacters
)

var (
	ErrCredentialRead     = errors.New("uplink credential could not be read")
	ErrCredentialInsecure = errors.New("uplink credential file permissions are unsafe")
	ErrCredentialInvalid  = errors.New("uplink credential is invalid")
)

// TokenSource loads the bearer credential immediately before a request. This
// permits an atomic token-file rotation without restarting Leviathan.
type TokenSource interface {
	Token(context.Context) (string, error)
}

type TokenSourceFunc func(context.Context) (string, error)

func (function TokenSourceFunc) Token(ctx context.Context) (string, error) {
	return function(ctx)
}

// FileTokenSource reads a root-managed regular file. Group/world access and
// symlinks are rejected. A single trailing LF (or CRLF) is accepted to make
// provisioned credential files practical; other whitespace is not.
type FileTokenSource struct {
	path string
}

func NewFileTokenSource(path string) (*FileTokenSource, error) {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, ErrCredentialRead
	}
	source := &FileTokenSource{path: path}
	// Fail enabled service startup on a missing, unsafe, or malformed
	// credential. Token still reloads the file for every request so later
	// atomic rotation does not require a process restart.
	if _, err := source.Token(context.Background()); err != nil {
		return nil, err
	}
	return source, nil
}

func (source *FileTokenSource) Token(ctx context.Context) (string, error) {
	if source == nil || source.path == "" || ctx == nil {
		return "", ErrCredentialRead
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}

	linkInfo, err := os.Lstat(source.path)
	if err != nil || !linkInfo.Mode().IsRegular() || linkInfo.Mode()&os.ModeSymlink != 0 {
		return "", ErrCredentialRead
	}
	if linkInfo.Mode().Perm()&0o077 != 0 {
		return "", ErrCredentialInsecure
	}
	file, err := os.Open(source.path)
	if err != nil {
		return "", ErrCredentialRead
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(linkInfo, openedInfo) {
		return "", ErrCredentialRead
	}
	if openedInfo.Mode().Perm()&0o077 != 0 {
		return "", ErrCredentialInsecure
	}

	document, err := io.ReadAll(io.LimitReader(file, int64(machineTokenLength+3)))
	if err != nil || len(document) > machineTokenLength+2 {
		return "", ErrCredentialRead
	}
	if len(document) > 0 && document[len(document)-1] == '\n' {
		document = document[:len(document)-1]
		if len(document) > 0 && document[len(document)-1] == '\r' {
			document = document[:len(document)-1]
		}
	}
	token := string(document)
	if !validMachineToken(token) {
		return "", ErrCredentialInvalid
	}
	return token, nil
}

func validMachineToken(token string) bool {
	if len(token) != machineTokenLength || token[:len(machineTokenPrefix)] != machineTokenPrefix {
		return false
	}
	separator := len(machineTokenPrefix) + machineLookupCharacters
	if token[separator] != '_' {
		return false
	}
	lookup := token[len(machineTokenPrefix):separator]
	secret := token[separator+1:]
	return validRawBase64URL(lookup, machineLookupBytes) && validRawBase64URL(secret, machineSecretBytes)
}

func validRawBase64URL(value string, expectedBytes int) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == expectedBytes && base64.RawURLEncoding.EncodeToString(decoded) == value
}
