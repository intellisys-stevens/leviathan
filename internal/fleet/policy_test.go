package fleet

import "testing"

const (
	instanceOne   = "11111111-1111-4111-8111-111111111111"
	instanceTwo   = "22222222-2222-4222-8222-222222222222"
	instanceThree = "33333333-3333-4333-8333-333333333333"
	instanceFour  = "44444444-4444-4444-8444-444444444444"
)

func TestPolicyRequiresExactUUIDCreatorAndActiveState(t *testing.T) {
	policy, err := NewPolicy(map[string]AllowedIdentity{instanceOne: {
		CreatorID: "nova-user-a", CreatorUsername: "owner-a@example.test", AgentConfigured: true,
	}})
	if err != nil {
		t.Fatalf("NewPolicy() error = %v", err)
	}

	tests := []struct {
		name     string
		instance Instance
		managed  bool
		eligible bool
		reason   PolicyReason
	}{
		{
			name:     "exact pair and active",
			instance: Instance{UUID: instanceOne, CreatorID: "nova-user-a", CreatorUsername: "advisory-metadata@example.test", CloudState: CloudStateActive},
			managed:  true,
			eligible: true,
			reason:   PolicyAllowed,
		},
		{
			name:     "unknown UUID",
			instance: Instance{UUID: instanceTwo, CreatorID: "nova-user-a", CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive},
			reason:   PolicyNotAllowlisted,
		},
		{
			name:     "creator mismatch",
			instance: Instance{UUID: instanceOne, CreatorID: "nova-user-b", CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive},
			reason:   PolicyCreatorMismatch,
		},
		{
			name:     "case mismatch is denied",
			instance: Instance{UUID: instanceOne, CreatorID: "Nova-User-A", CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive},
			reason:   PolicyCreatorMismatch,
		},
		{
			name:     "shelved instance",
			instance: Instance{UUID: instanceOne, CreatorID: "nova-user-a", CreatorUsername: "owner-a@example.test", CloudState: CloudStateShelvedOffloaded},
			managed:  true,
			reason:   PolicyCloudNotActive,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			decision := policy.Evaluate(test.instance)
			if decision.Allowlisted != test.managed || decision.AgentProbeEligible != test.eligible || decision.Reason != test.reason {
				t.Fatalf("Evaluate() = %+v, want managed=%v eligible=%v reason=%q", decision, test.managed, test.eligible, test.reason)
			}
			if decision.Allowlisted && decision.CreatorUsername != "owner-a@example.test" {
				t.Fatalf("trusted creator label = %q", decision.CreatorUsername)
			}
		})
	}
}

func TestPolicyZeroValueDeniesEverything(t *testing.T) {
	decision := (Policy{}).Evaluate(Instance{
		UUID: instanceOne, CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive,
	})
	if decision.Allowlisted || decision.AgentProbeEligible || decision.Reason != PolicyNotAllowlisted {
		t.Fatalf("zero-value Policy.Evaluate() = %+v, want fail-closed", decision)
	}
}

func TestNewPolicyRejectsAmbiguousEntries(t *testing.T) {
	tests := []struct {
		name    string
		entries map[string]AllowedIdentity
	}{
		{name: "non canonical UUID", entries: map[string]AllowedIdentity{"server-one": {CreatorID: "user-a", CreatorUsername: "owner@example.test"}}},
		{name: "uppercase UUID", entries: map[string]AllowedIdentity{"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA": {CreatorID: "user-a", CreatorUsername: "owner@example.test"}}},
		{name: "empty creator ID", entries: map[string]AllowedIdentity{instanceOne: {CreatorUsername: "owner@example.test"}}},
		{name: "creator ID whitespace", entries: map[string]AllowedIdentity{instanceOne: {CreatorID: " user-a", CreatorUsername: "owner@example.test"}}},
		{name: "empty creator", entries: map[string]AllowedIdentity{instanceOne: {CreatorID: "user-a"}}},
		{name: "creator whitespace", entries: map[string]AllowedIdentity{instanceOne: {CreatorID: "user-a", CreatorUsername: " owner@example.test"}}},
		{name: "creator wildcard", entries: map[string]AllowedIdentity{instanceOne: {CreatorID: "user-a", CreatorUsername: "*@example.test"}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewPolicy(test.entries); err == nil {
				t.Fatal("NewPolicy() error = nil, want rejection")
			}
		})
	}
}

func TestPolicyReportsMissingAgentBindingWithoutProbing(t *testing.T) {
	policy, err := NewPolicy(map[string]AllowedIdentity{instanceOne: {
		CreatorID: "nova-user-a", CreatorUsername: "owner-a@example.test", AgentConfigured: false,
	}})
	if err != nil {
		t.Fatal(err)
	}
	decision := policy.Evaluate(Instance{UUID: instanceOne, CreatorID: "nova-user-a", CloudState: CloudStateActive})
	if !decision.Allowlisted || decision.AgentProbeEligible || decision.Reason != PolicyAgentNotConfigured {
		t.Fatalf("decision = %+v", decision)
	}
}

func TestNormalizeCloudState(t *testing.T) {
	tests := map[string]CloudState{
		"ACTIVE":              CloudStateActive,
		"shelved":             CloudStateShelved,
		" SHELVED_OFFLOADED ": CloudStateShelvedOffloaded,
		"SHUTOFF":             CloudStateShutoff,
		"STOPPED":             CloudStateShutoff,
		"BUILD":               CloudStateBuilding,
		"REBUILD":             CloudStateBuilding,
		"PAUSED":              CloudStatePaused,
		"SUSPENDED":           CloudStateSuspended,
		"ERROR":               CloudStateError,
		"PASSWORD":            CloudStateUnknown,
		"":                    CloudStateUnknown,
	}
	for raw, expected := range tests {
		if got := NormalizeCloudState(raw); got != expected {
			t.Errorf("NormalizeCloudState(%q) = %q, want %q", raw, got, expected)
		}
	}
}
