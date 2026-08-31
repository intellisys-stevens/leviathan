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

func TestPolicyDynamicallyAllowsExactNovaCreator(t *testing.T) {
	policy, err := NewPolicyWithCreators(nil, []AllowedCreator{
		{
			CreatorID: "nova-user-a", CreatorUsername: "owner-a@example.test", TelemetryEnabled: true,
		},
		{
			CreatorID: "nova-user-b", CreatorUsername: "owner-b@example.test", TelemetryEnabled: false,
		},
	})
	if err != nil {
		t.Fatalf("NewPolicyWithCreators() error = %v", err)
	}

	tests := []struct {
		name     string
		instance Instance
		managed  bool
		eligible bool
		reason   PolicyReason
		username string
	}{
		{
			name:     "matching creator with telemetry",
			instance: Instance{UUID: instanceOne, CreatorID: "nova-user-a", CreatorUsername: "advisory@example.test", CloudState: CloudStateActive},
			managed:  true, eligible: true, reason: PolicyAllowed, username: "owner-a@example.test",
		},
		{
			name:     "matching creator without telemetry",
			instance: Instance{UUID: instanceTwo, CreatorID: "nova-user-b", CloudState: CloudStateActive},
			managed:  true, reason: PolicyAgentNotConfigured, username: "owner-b@example.test",
		},
		{
			name:     "matching creator but inactive",
			instance: Instance{UUID: instanceThree, CreatorID: "nova-user-a", CloudState: CloudStateShelved},
			managed:  true, reason: PolicyCloudNotActive, username: "owner-a@example.test",
		},
		{
			name:     "creator comparison is exact",
			instance: Instance{UUID: instanceFour, CreatorID: "Nova-User-A", CloudState: CloudStateActive},
			reason:   PolicyNotAllowlisted,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			decision := policy.Evaluate(test.instance)
			if decision.Allowlisted != test.managed || decision.AgentProbeEligible != test.eligible || decision.Reason != test.reason || decision.CreatorUsername != test.username {
				t.Fatalf("Evaluate() = %+v, want managed=%v eligible=%v reason=%q username=%q", decision, test.managed, test.eligible, test.reason, test.username)
			}
		})
	}
}

func TestPolicyExplicitUUIDWinsOverCreatorRule(t *testing.T) {
	policy, err := NewPolicyWithCreators(
		map[string]AllowedIdentity{
			instanceOne: {CreatorID: "nova-user-a", CreatorUsername: "owner-a@example.test", AgentConfigured: false},
			instanceTwo: {CreatorID: "nova-user-a", CreatorUsername: "owner-a@example.test", AgentConfigured: true},
		},
		[]AllowedCreator{
			{CreatorID: "nova-user-a", CreatorUsername: "owner-a@example.test", TelemetryEnabled: true},
			{CreatorID: "nova-user-b", CreatorUsername: "owner-b@example.test", TelemetryEnabled: true},
		},
	)
	if err != nil {
		t.Fatalf("NewPolicyWithCreators() error = %v", err)
	}

	withoutBinding := policy.Evaluate(Instance{UUID: instanceOne, CreatorID: "nova-user-a", CloudState: CloudStateActive})
	if !withoutBinding.Allowlisted || withoutBinding.AgentProbeEligible || withoutBinding.Reason != PolicyAgentNotConfigured {
		t.Fatalf("explicit no-agent decision = %+v, want explicit rule to suppress creator telemetry", withoutBinding)
	}

	mismatch := policy.Evaluate(Instance{UUID: instanceTwo, CreatorID: "nova-user-b", CloudState: CloudStateActive})
	if mismatch.Allowlisted || mismatch.AgentProbeEligible || mismatch.Reason != PolicyCreatorMismatch {
		t.Fatalf("explicit mismatch decision = %+v, want fail-closed without creator fallback", mismatch)
	}
}

func TestNewPolicyWithCreatorsRejectsAmbiguousCreatorRules(t *testing.T) {
	tests := []struct {
		name      string
		instances map[string]AllowedIdentity
		creators  []AllowedCreator
	}{
		{
			name: "duplicate creator ID",
			creators: []AllowedCreator{
				{CreatorID: "nova-user-a", CreatorUsername: "owner@example.test"},
				{CreatorID: "nova-user-a", CreatorUsername: "owner@example.test"},
			},
		},
		{
			name: "wildcard creator ID",
			creators: []AllowedCreator{
				{CreatorID: "nova-user-*", CreatorUsername: "owner@example.test"},
			},
		},
		{
			name: "wildcard creator username",
			creators: []AllowedCreator{
				{CreatorID: "nova-user-a", CreatorUsername: "*@example.test"},
			},
		},
		{
			name: "creator conflicts with exact instance label",
			instances: map[string]AllowedIdentity{
				instanceOne: {CreatorID: "nova-user-a", CreatorUsername: "first@example.test"},
			},
			creators: []AllowedCreator{
				{CreatorID: "nova-user-a", CreatorUsername: "second@example.test"},
			},
		},
		{
			name: "same creator ID conflicts across exact instances",
			instances: map[string]AllowedIdentity{
				instanceOne: {CreatorID: "nova-user-a", CreatorUsername: "first@example.test"},
				instanceTwo: {CreatorID: "nova-user-a", CreatorUsername: "second@example.test"},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewPolicyWithCreators(test.instances, test.creators); err == nil {
				t.Fatal("NewPolicyWithCreators() error = nil, want rejection")
			}
		})
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
