package cli

import (
	"encoding/json"

	"github.com/intellisys-stevens/leviathan/internal/updateprotocol"
	"github.com/spf13/cobra"
)

// configCheckCommand runs the normal strict configuration preparation without
// opening collectors, credentials, listeners, or persistent history files.
func (a *application) configCheckCommand() *cobra.Command {
	return &cobra.Command{
		Use: "config-check", Short: "Validate configuration without starting collectors or changing state", Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return json.NewEncoder(a.stdout).Encode(map[string]any{"valid": true, "configProfile": updateprotocol.ConfigProfile, "stateProfile": updateprotocol.StateProfile})
		},
	}
}
