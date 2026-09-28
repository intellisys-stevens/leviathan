package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/intellisys-stevens/leviathan/internal/app"
	"github.com/intellisys-stevens/leviathan/internal/plugins"
	"github.com/spf13/cobra"
)

func (a *application) pluginsCommand() *cobra.Command {
	root := &cobra.Command{Use: "plugins", Short: "Inspect installed plugin configuration and endpoint health"}
	for _, action := range []string{"list", "inspect", "check"} {
		format := "text"
		command := &cobra.Command{Use: action, Short: map[string]string{"list": "List configured plugins without opening endpoints", "inspect": "Inspect one configured plugin", "check": "Validate endpoints with bounded observation requests"}[action], Args: cobra.NoArgs}
		if action == "inspect" {
			command.Use = "inspect ID"
			command.Args = cobra.ExactArgs(1)
		}
		command.RunE = func(command *cobra.Command, args []string) error {
			if format != "text" && format != "json" {
				return errors.New("format must be text or json")
			}
			_, runtime, err := app.NewEngine(a.cfg)
			if err != nil {
				return err
			}
			var checkErr error
			if action == "check" {
				checkErr = runtime.Check(command.Context(), nil)
			}
			states := runtime.List()
			if action == "inspect" {
				selected := []plugins.Health{}
				for _, state := range states {
					if state.ID == args[0] {
						selected = append(selected, state)
					}
				}
				if len(selected) == 0 {
					return fmt.Errorf("plugin %q is not configured", args[0])
				}
				states = selected
			}
			if format == "json" {
				if err := json.NewEncoder(a.stdout).Encode(struct {
					Plugins []plugins.Health `json:"plugins"`
				}{states}); err != nil {
					return err
				}
			} else {
				for _, state := range states {
					capabilities := []string{}
					for _, capability := range state.Capabilities {
						capabilities = append(capabilities, string(capability.Capability)+"="+capability.Status)
					}
					fmt.Fprintf(a.stdout, "%s\t%s\t%s\t%s\t%s\n", state.ID, state.Implementation, state.Transport, state.Status, strings.Join(capabilities, ", "))
					if state.Message != "" {
						fmt.Fprintf(a.stdout, "  %s\n", state.Message)
					}
				}
			}
			return checkErr
		}
		command.Flags().StringVarP(&format, "format", "f", format, "output format: text or json")
		root.AddCommand(command)
	}
	return root
}
