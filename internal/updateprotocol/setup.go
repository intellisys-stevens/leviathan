package updateprotocol

import "time"

const (
	SetupRedeemPath    = "/api/node-control/v1/updates/setup/redeem"
	SetupAuthorizePath = "/api/node-control/v1/updates/setup/authorize"
	SetupArtifactPath  = "/api/node-control/v1/updates/setup/artifact"
	SetupReportPath    = "/api/node-control/v1/updates/setup/report"
	SetupStatusPath    = "/api/node-control/v1/updates/setup/status"
	SetupTicketsPath   = BrowserPrefix + "/setup-tickets"
)

type SetupState string

const (
	SetupIssued           SetupState = "issued"
	SetupRedeemed         SetupState = "redeemed"
	SetupInstalling       SetupState = "installing"
	SetupVerifying        SetupState = "verifying"
	SetupSucceeded        SetupState = "succeeded"
	SetupFailed           SetupState = "failed"
	SetupRecoveryRequired SetupState = "recovery_required"
	SetupExpired          SetupState = "expired"
	SetupSuperseded       SetupState = "superseded"
)

func (s SetupState) Terminal() bool {
	return s == SetupSucceeded || s == SetupFailed || s == SetupRecoveryRequired || s == SetupExpired || s == SetupSuperseded
}

type SetupMode string

const (
	SetupInstall SetupMode = "install"
	SetupAdopt   SetupMode = "adopt"
)

type SetupReleaseSummary struct {
	Version       string   `json:"version"`
	Commit        string   `json:"commit"`
	Architectures []string `json:"architectures"`
}

type SetupSummary struct {
	ID            string     `json:"id"`
	Machine       MachineKey `json:"machine"`
	Version       string     `json:"version"`
	Commit        string     `json:"commit"`
	Architectures []string   `json:"architectures"`
	AllowPreview  bool       `json:"allowPreview"`
	Status        SetupState `json:"status"`
	RequestedBy   string     `json:"requestedBy"`
	CreatedAt     time.Time  `json:"createdAt"`
	ExpiresAt     time.Time  `json:"expiresAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	Code          string     `json:"code,omitempty"`
}

type SetupTicketRequest struct {
	Machine      MachineKey `json:"machine"`
	Version      string     `json:"version"`
	RequestID    string     `json:"requestId"`
	AllowPreview bool       `json:"allowPreview"`
}

// Command is delivered only on initial creation. An idempotent browser retry
// returns the original metadata without recovering plaintext ticket material.
// A new request ID may replace the same administrator's unredeemed ticket.
type SetupTicketResponse struct {
	Setup   SetupSummary `json:"setup"`
	Command string       `json:"command,omitempty"`
}

type SetupRedeemRequest struct {
	Ticket string `json:"ticket"`
	CSRPEM string `json:"csrPem"`
	Arch   string `json:"arch"`
}

type SetupRedeemResponse struct {
	Schema       string              `json:"schema"`
	SetupID      string              `json:"setupId"`
	Machine      MachineKey          `json:"machine"`
	ExpiresAt    time.Time           `json:"expiresAt"`
	Release      SignedManifest      `json:"release"`
	Certificate  CertificateResponse `json:"certificate"`
	AllowPreview bool                `json:"allowPreview"`
}

type SetupAuthorizeRequest struct {
	SetupID      string       `json:"setupId"`
	Mode         SetupMode    `json:"mode"`
	Installation Installation `json:"installation"`
}

type SetupAuthorizeResponse struct {
	Schema        string    `json:"schema"`
	SetupID       string    `json:"setupId"`
	Allowed       bool      `json:"allowed"`
	InstallBefore time.Time `json:"installBefore"`
	AllowPreview  bool      `json:"allowPreview"`
}

type SetupArtifactRequest struct {
	SetupID       string `json:"setupId"`
	ArchiveSHA256 string `json:"archiveSha256"`
}

type SetupReportRequest struct {
	SetupID              string       `json:"setupId"`
	Status               SetupState   `json:"status"`
	Installation         Installation `json:"installation"`
	InstallationVerified bool         `json:"installationVerified"`
	Code                 string       `json:"code,omitempty"`
}

type SetupStatusRequest struct {
	SetupID string `json:"setupId"`
}

type SetupStatusResponse struct {
	Schema       string        `json:"schema"`
	Setup        SetupSummary  `json:"setup"`
	Installation *Installation `json:"installation"`
}
