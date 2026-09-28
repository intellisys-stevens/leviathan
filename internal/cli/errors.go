package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// CommandError carries a stable category while preserving the underlying error
// and the CLI's historical nonzero exit status.
type CommandError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	cause      error
	structured bool
}

func (e *CommandError) Error() string { return e.Message }
func (e *CommandError) Unwrap() error { return e.cause }
func commandError(err error, code string, structured bool) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) {
		code = "canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		code = "timeout"
	}
	return &CommandError{Code: code, Message: err.Error(), cause: err, structured: structured}
}

// WriteError writes only to the caller's stderr. Successful JSON/JSONL stdout
// and default text errors keep their existing formats.
func WriteError(writer io.Writer, err error) {
	var command *CommandError
	if errors.As(err, &command) && command.structured {
		_ = json.NewEncoder(writer).Encode(struct {
			Error *CommandError `json:"error"`
		}{command})
		return
	}
	fmt.Fprintln(writer, "leviathan:", err)
}
