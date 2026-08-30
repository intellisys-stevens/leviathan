package fleet

import (
	"fmt"
	"regexp"
	"strings"
)

var openStackUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Policy is an exact instance UUID -> authoritative Nova creator identity
// allowlist. Its zero value denies every instance.
type Policy struct {
	identities map[string]AllowedIdentity
}

// AllowedIdentity pins one cloud instance to the authoritative Nova user_id.
// CreatorUsername is a trusted display label from configuration; discovered
// Exosphere metadata is never used as an authorization factor.
type AllowedIdentity struct {
	CreatorID       string
	CreatorUsername string
	AgentConfigured bool
}

type Decision struct {
	Allowlisted        bool
	AgentProbeEligible bool
	Reason             PolicyReason
	CreatorUsername    string
}

func NewPolicy(entries map[string]AllowedIdentity) (Policy, error) {
	identities := make(map[string]AllowedIdentity, len(entries))
	for instanceUUID, identity := range entries {
		if !openStackUUID.MatchString(instanceUUID) {
			return Policy{}, fmt.Errorf("allowlist instance UUID must be a canonical lowercase UUID")
		}
		if !validPolicyIdentity(identity.CreatorID) {
			return Policy{}, fmt.Errorf("allowlist creator ID for %s must be an exact non-empty identifier", instanceUUID)
		}
		if !validPolicyIdentity(identity.CreatorUsername) {
			return Policy{}, fmt.Errorf("allowlist creator for %s must be an exact non-empty username", instanceUUID)
		}
		identities[instanceUUID] = identity
	}
	return Policy{identities: identities}, nil
}

func (p Policy) Evaluate(instance Instance) Decision {
	expected, found := p.identities[instance.UUID]
	if !found {
		return Decision{Reason: PolicyNotAllowlisted}
	}
	if expected.CreatorID != instance.CreatorID {
		return Decision{Reason: PolicyCreatorMismatch}
	}
	if instance.CloudState != CloudStateActive {
		return Decision{Allowlisted: true, Reason: PolicyCloudNotActive, CreatorUsername: expected.CreatorUsername}
	}
	if !expected.AgentConfigured {
		return Decision{Allowlisted: true, Reason: PolicyAgentNotConfigured, CreatorUsername: expected.CreatorUsername}
	}
	return Decision{Allowlisted: true, AgentProbeEligible: true, Reason: PolicyAllowed, CreatorUsername: expected.CreatorUsername}
}

func validPolicyIdentity(value string) bool {
	if value == "" || len(value) > 256 || strings.TrimSpace(value) != value || strings.ContainsAny(value, "*?") {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}
