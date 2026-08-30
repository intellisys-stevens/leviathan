package fleet

import (
	"fmt"
	"regexp"
	"strings"
)

var openStackUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Policy is an exact instance UUID -> creator username allowlist. Its zero
// value denies every instance.
type Policy struct {
	creators map[string]string
}

type Decision struct {
	Allowlisted        bool
	AgentProbeEligible bool
	Reason             PolicyReason
}

func NewPolicy(entries map[string]string) (Policy, error) {
	creators := make(map[string]string, len(entries))
	for instanceUUID, creator := range entries {
		if !openStackUUID.MatchString(instanceUUID) {
			return Policy{}, fmt.Errorf("allowlist instance UUID must be a canonical lowercase UUID")
		}
		if creator == "" || strings.TrimSpace(creator) != creator || strings.ContainsAny(creator, "*?") {
			return Policy{}, fmt.Errorf("allowlist creator for %s must be an exact non-empty username", instanceUUID)
		}
		creators[instanceUUID] = creator
	}
	return Policy{creators: creators}, nil
}

func (p Policy) Evaluate(instance Instance) Decision {
	expectedCreator, found := p.creators[instance.UUID]
	if !found {
		return Decision{Reason: PolicyNotAllowlisted}
	}
	if expectedCreator != instance.CreatorUsername {
		return Decision{Reason: PolicyCreatorMismatch}
	}
	if instance.CloudState != CloudStateActive {
		return Decision{Allowlisted: true, Reason: PolicyCloudNotActive}
	}
	return Decision{Allowlisted: true, AgentProbeEligible: true, Reason: PolicyAllowed}
}
