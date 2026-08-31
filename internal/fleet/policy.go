package fleet

import (
	"fmt"
	"regexp"
	"strings"
)

var openStackUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Policy evaluates exact instance identities before creator-wide identities.
// Its zero value denies every instance.
type Policy struct {
	identities map[string]AllowedIdentity
	creators   map[string]AllowedCreator
}

// AllowedIdentity pins one cloud instance to the authoritative Nova user_id.
// CreatorUsername is a trusted display label from configuration; discovered
// Exosphere metadata is never used as an authorization factor.
type AllowedIdentity struct {
	CreatorID       string
	CreatorUsername string
	AgentConfigured bool
}

// AllowedCreator dynamically manages instances whose authoritative Nova
// user_id matches CreatorID. TelemetryEnabled is deliberately independent from
// inventory management so a creator's instances can remain visible without
// becoming agent probe targets.
type AllowedCreator struct {
	CreatorID        string
	CreatorUsername  string
	TelemetryEnabled bool
}

type Decision struct {
	Allowlisted        bool
	AgentProbeEligible bool
	Reason             PolicyReason
	CreatorUsername    string
}

func NewPolicy(entries map[string]AllowedIdentity) (Policy, error) {
	return NewPolicyWithCreators(entries, nil)
}

// NewPolicyWithCreators builds a policy containing exact UUID pins and optional
// creator-wide rules. An exact UUID entry always wins during evaluation,
// including when its creator does not match, so creator rules cannot weaken an
// explicit pin.
func NewPolicyWithCreators(entries map[string]AllowedIdentity, creatorEntries []AllowedCreator) (Policy, error) {
	identities := make(map[string]AllowedIdentity, len(entries))
	creatorNames := make(map[string]string, len(entries)+len(creatorEntries))
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
		if existing, found := creatorNames[identity.CreatorID]; found && existing != identity.CreatorUsername {
			return Policy{}, fmt.Errorf("creator ID %s has conflicting usernames", identity.CreatorID)
		}
		creatorNames[identity.CreatorID] = identity.CreatorUsername
		identities[instanceUUID] = identity
	}

	creators := make(map[string]AllowedCreator, len(creatorEntries))
	for _, creator := range creatorEntries {
		if !validPolicyIdentity(creator.CreatorID) {
			return Policy{}, fmt.Errorf("creator allowlist ID must be an exact non-empty identifier")
		}
		if !validPolicyIdentity(creator.CreatorUsername) {
			return Policy{}, fmt.Errorf("creator allowlist username must be an exact non-empty username")
		}
		if existing, found := creatorNames[creator.CreatorID]; found && existing != creator.CreatorUsername {
			return Policy{}, fmt.Errorf("creator ID %s has conflicting usernames", creator.CreatorID)
		}
		if _, duplicate := creators[creator.CreatorID]; duplicate {
			return Policy{}, fmt.Errorf("creator allowlist IDs must be unique")
		}
		creatorNames[creator.CreatorID] = creator.CreatorUsername
		creators[creator.CreatorID] = creator
	}
	return Policy{identities: identities, creators: creators}, nil
}

func (p Policy) Evaluate(instance Instance) Decision {
	expected, found := p.identities[instance.UUID]
	if found {
		if expected.CreatorID != instance.CreatorID {
			return Decision{Reason: PolicyCreatorMismatch}
		}
		return allowedDecision(instance, expected.CreatorUsername, expected.AgentConfigured)
	}

	creator, found := p.creators[instance.CreatorID]
	if !found {
		return Decision{Reason: PolicyNotAllowlisted}
	}
	return allowedDecision(instance, creator.CreatorUsername, creator.TelemetryEnabled)
}

func allowedDecision(instance Instance, creatorUsername string, telemetryEnabled bool) Decision {
	if instance.CloudState != CloudStateActive {
		return Decision{Allowlisted: true, Reason: PolicyCloudNotActive, CreatorUsername: creatorUsername}
	}
	if !telemetryEnabled {
		return Decision{Allowlisted: true, Reason: PolicyAgentNotConfigured, CreatorUsername: creatorUsername}
	}
	return Decision{Allowlisted: true, AgentProbeEligible: true, Reason: PolicyAllowed, CreatorUsername: creatorUsername}
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
