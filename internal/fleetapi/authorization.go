package fleetapi

import (
	"crypto/sha256"
	"crypto/subtle"

	"github.com/intellisys-stevens/miglens/internal/fleet"
)

// UplinkAuthorizer performs the current-inventory portion of uplink
// authorization. Implementations must make every lookup bounded and must fail
// closed while inventory is unavailable or stale.
type UplinkAuthorizer interface {
	Authorized(projectID, creatorID, instanceUUID string) bool
}

// ProjectUplinkAuthorizer binds the controller's atomically published O(1)
// eligibility index to one exact OpenStack project. Project IDs are compared as
// fixed-size digests, and the underlying lookup is performed even when the
// project is wrong so invalid bearer tokens do not select a cheaper path.
type ProjectUplinkAuthorizer struct {
	projectDigest [sha256.Size]byte
	source        fleet.UplinkAuthorizationSource
}

func NewProjectUplinkAuthorizer(projectID string, source fleet.UplinkAuthorizationSource) (*ProjectUplinkAuthorizer, error) {
	if !validUplinkIdentity(projectID) || source == nil {
		return nil, ErrInvalidUplinkConfig
	}
	return &ProjectUplinkAuthorizer{
		projectDigest: sha256.Sum256([]byte(projectID)),
		source:        source,
	}, nil
}

func (authorizer *ProjectUplinkAuthorizer) Authorized(projectID, creatorID, instanceUUID string) bool {
	if authorizer == nil || authorizer.source == nil {
		return false
	}
	projectDigest := sha256.Sum256([]byte(projectID))
	projectMatches := subtle.ConstantTimeCompare(projectDigest[:], authorizer.projectDigest[:])
	eligible := authorizer.source.UplinkAuthorized(creatorID, instanceUUID)
	return projectMatches == 1 && eligible
}
