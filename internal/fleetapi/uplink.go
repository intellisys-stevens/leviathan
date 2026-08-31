package fleetapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/intellisys-stevens/miglens/internal/fleet"
	"github.com/intellisys-stevens/miglens/internal/fleetuplink"
	"github.com/intellisys-stevens/miglens/internal/model"
)

const (
	minimumUplinkTokenBytes = 32
	maximumUplinkTokenBytes = 512

	// DefaultUplinkConcurrentRequests is the receiver's zero-value ingress
	// concurrency. MaximumUplinkConcurrentRequests is the absolute gate size.
	DefaultUplinkConcurrentRequests = 8
	MaximumUplinkConcurrentRequests = 64
	// MaximumUplinkInflightBytes bounds MaxBodyBytes multiplied by the effective
	// request concurrency. Constructors use division to avoid overflow.
	MaximumUplinkInflightBytes = int64(256 << 20)
)

var (
	ErrInvalidUplinkConfig = errors.New("fleet uplink HTTP configuration is invalid")
	canonicalInstanceUUID  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	errMalformedEnvelope   = errors.New("malformed fleet uplink envelope")
)

// UplinkRegistry is the bounded, replay-resistant store used by the HTTP
// receiver. fleetuplink.Registry satisfies this interface.
type UplinkRegistry interface {
	Put(projectID, instanceUUID string, bodyBytes int64, sample fleet.AgentSample, now time.Time) error
}

// UplinkConfig enables authenticated agent-pushed telemetry for one exact
// OpenStack project. CreatorTokens maps authoritative Nova user_id values to
// independent creator-scoped bearer tokens. A token authenticates a creator
// trust domain rather than a specific VM; Authorizer validates each claimed
// UUID against current inventory. Tokens are hashed during construction and
// are never retained in plaintext.
type UplinkConfig struct {
	Registry              UplinkRegistry
	Authorizer            UplinkAuthorizer
	ProjectID             string
	CreatorTokens         map[string]string
	MaxBodyBytes          int64
	MaxConcurrentRequests int
	Now                   func() time.Time
}

type uplinkIdentity struct {
	projectID string
	creatorID string
}

type uplinkHandler struct {
	authorizer   UplinkAuthorizer
	registry     UplinkRegistry
	tokenDigests map[[sha256.Size]byte]uplinkIdentity
	projectID    string
	maxBodyBytes int64
	requestSlots chan struct{}
	now          func() time.Time
}

type uplinkEnvelope struct {
	snapshot  model.Snapshot
	buildInfo *model.BuildInfo
}

func newUplinkHandler(source DataSource, config UplinkConfig) (*uplinkHandler, error) {
	if source == nil || config.Registry == nil || config.Authorizer == nil || !validUplinkIdentity(config.ProjectID) || len(config.CreatorTokens) == 0 {
		return nil, ErrInvalidUplinkConfig
	}
	if config.MaxBodyBytes < 0 || config.MaxConcurrentRequests < 0 || config.MaxConcurrentRequests > MaximumUplinkConcurrentRequests {
		return nil, ErrInvalidUplinkConfig
	}
	if config.MaxBodyBytes == 0 {
		config.MaxBodyBytes = fleetuplink.DefaultMaxBodyBytes
	}
	if config.MaxConcurrentRequests == 0 {
		config.MaxConcurrentRequests = DefaultUplinkConcurrentRequests
	}
	if config.MaxBodyBytes > MaximumUplinkInflightBytes/int64(config.MaxConcurrentRequests) {
		return nil, ErrInvalidUplinkConfig
	}
	if config.Now == nil {
		config.Now = time.Now
	}

	digests := make(map[[sha256.Size]byte]uplinkIdentity, len(config.CreatorTokens))
	for creatorID, token := range config.CreatorTokens {
		if !validUplinkIdentity(creatorID) || !validUplinkToken(token) {
			return nil, ErrInvalidUplinkConfig
		}
		digest := uplinkTokenDigest(token)
		if _, duplicate := digests[digest]; duplicate {
			return nil, ErrInvalidUplinkConfig
		}
		digests[digest] = uplinkIdentity{projectID: config.ProjectID, creatorID: creatorID}
	}

	return &uplinkHandler{
		authorizer:   config.Authorizer,
		registry:     config.Registry,
		tokenDigests: digests,
		projectID:    config.ProjectID,
		maxBodyBytes: config.MaxBodyBytes,
		requestSlots: make(chan struct{}, config.MaxConcurrentRequests),
		now:          config.Now,
	}, nil
}

func (h *uplinkHandler) receive(writer http.ResponseWriter, request *http.Request) {
	select {
	case h.requestSlots <- struct{}{}:
		defer func() { <-h.requestSlots }()
	default:
		writer.Header().Set("Retry-After", "1")
		writeUplinkError(writer, http.StatusTooManyRequests)
		return
	}
	instanceUUID := request.PathValue("instanceUUID")
	if !canonicalInstanceUUID.MatchString(instanceUUID) || request.URL.RawQuery != "" || request.URL.ForceQuery ||
		(request.URL.RawPath != "" && request.URL.RawPath != request.URL.Path) {
		writeUplinkError(writer, http.StatusNotFound)
		return
	}
	contentTypes := request.Header.Values("Content-Type")
	if len(contentTypes) != 1 || contentTypes[0] != "application/json" || request.Header.Get("Content-Encoding") != "" {
		writeUplinkError(writer, http.StatusBadRequest)
		return
	}

	identity, authenticated := h.authenticate(request)
	// Always perform the same state lookup and return the same response shape
	// for authentication and authorization failures. This prevents the HTTP
	// response from acting as a bearer-token validity oracle.
	authorized := h.authorized(identity.creatorID, instanceUUID)
	if !authenticated || !authorized {
		writeUplinkUnauthorized(writer)
		return
	}

	if request.ContentLength > h.maxBodyBytes {
		writeUplinkError(writer, http.StatusRequestEntityTooLarge)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, h.maxBodyBytes+1))
	if err != nil {
		writeUplinkError(writer, http.StatusBadRequest)
		return
	}
	if int64(len(body)) > h.maxBodyBytes {
		writeUplinkError(writer, http.StatusRequestEntityTooLarge)
		return
	}
	envelope, err := decodeUplinkEnvelope(body)
	if err != nil {
		writeUplinkError(writer, http.StatusBadRequest)
		return
	}

	now := h.now().UTC()
	sample := fleet.AgentSample{
		InstanceUUID: instanceUUID,
		CreatorID:    identity.creatorID,
		Source:       fleet.TelemetrySourceMIGLensUplink,
		ObservedAt:   envelope.snapshot.SampledAt,
		BuildInfo:    envelope.buildInfo,
		Snapshot:     envelope.snapshot,
	}
	if err := h.registry.Put(identity.projectID, instanceUUID, int64(len(body)), sample, now); err != nil {
		writeUplinkRegistryError(writer, err)
		return
	}
	writeJSON(writer, http.StatusAccepted, map[string]string{"status": "accepted"})
}

func (h *uplinkHandler) authenticate(request *http.Request) (uplinkIdentity, bool) {
	values := request.Header.Values("Authorization")
	token := ""
	wellFormed := len(values) == 1 && strings.HasPrefix(values[0], "Bearer ")
	valid := false
	if wellFormed {
		candidate := strings.TrimPrefix(values[0], "Bearer ")
		valid = validUplinkToken(candidate)
		// Do not hash arbitrarily large invalid header values. The HTTP server
		// has its own header cap, but authentication work should remain bounded
		// by the credential contract rather than that broader transport limit.
		if valid {
			token = candidate
		}
	}
	identity, found := h.tokenDigests[uplinkTokenDigest(token)]
	return identity, wellFormed && valid && found
}

func uplinkTokenDigest(token string) [sha256.Size]byte {
	// Frame every valid token into the same fixed-size input so missing,
	// malformed, unknown, and configured credentials all perform one SHA-256
	// operation over the same number of bytes. Length framing preserves token
	// identity despite zero padding.
	var framed [2 + maximumUplinkTokenBytes]byte
	binary.BigEndian.PutUint16(framed[:2], uint16(len(token)))
	copy(framed[2:], token)
	return sha256.Sum256(framed[:])
}

func (h *uplinkHandler) authorized(creatorID, instanceUUID string) bool {
	return h.authorizer.Authorized(h.projectID, creatorID, instanceUUID)
}

func decodeUplinkEnvelope(body []byte) (uplinkEnvelope, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return uplinkEnvelope{}, errMalformedEnvelope
	}

	var snapshotJSON json.RawMessage
	var buildInfoJSON json.RawMessage
	seen := make(map[string]struct{}, 2)
	for decoder.More() {
		keyToken, err := decoder.Token()
		key, ok := keyToken.(string)
		if err != nil || !ok {
			return uplinkEnvelope{}, errMalformedEnvelope
		}
		if _, duplicate := seen[key]; duplicate {
			return uplinkEnvelope{}, errMalformedEnvelope
		}
		seen[key] = struct{}{}
		switch key {
		case "snapshot":
			if err := decoder.Decode(&snapshotJSON); err != nil {
				return uplinkEnvelope{}, errMalformedEnvelope
			}
		case "buildInfo":
			if err := decoder.Decode(&buildInfoJSON); err != nil {
				return uplinkEnvelope{}, errMalformedEnvelope
			}
		default:
			return uplinkEnvelope{}, errMalformedEnvelope
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') || len(snapshotJSON) == 0 || bytes.Equal(bytes.TrimSpace(snapshotJSON), []byte("null")) {
		return uplinkEnvelope{}, errMalformedEnvelope
	}
	if token, err := decoder.Token(); err != io.EOF || token != nil {
		return uplinkEnvelope{}, errMalformedEnvelope
	}

	var snapshot model.Snapshot
	if err := strictJSONDecode(snapshotJSON, &snapshot); err != nil {
		return uplinkEnvelope{}, errMalformedEnvelope
	}
	envelope := uplinkEnvelope{snapshot: snapshot}
	if len(buildInfoJSON) != 0 && !bytes.Equal(bytes.TrimSpace(buildInfoJSON), []byte("null")) {
		var buildInfo model.BuildInfo
		if err := strictJSONDecode(buildInfoJSON, &buildInfo); err != nil {
			return uplinkEnvelope{}, errMalformedEnvelope
		}
		envelope.buildInfo = &buildInfo
	}
	return envelope, nil
}

func strictJSONDecode(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if token, err := decoder.Token(); err != io.EOF || token != nil {
		return errMalformedEnvelope
	}
	return nil
}

func writeUplinkRegistryError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, fleetuplink.ErrBodyTooLarge):
		writeUplinkError(writer, http.StatusRequestEntityTooLarge)
	case errors.Is(err, fleetuplink.ErrReplay), errors.Is(err, fleetuplink.ErrCapacity):
		writeUplinkError(writer, http.StatusConflict)
	case errors.Is(err, fleetuplink.ErrInvalidBodySize),
		errors.Is(err, fleetuplink.ErrInvalidIdentity),
		errors.Is(err, fleetuplink.ErrInvalidSample),
		errors.Is(err, fleetuplink.ErrIncompatibleSchema),
		errors.Is(err, fleetuplink.ErrSampleTooOld),
		errors.Is(err, fleetuplink.ErrSampleInFuture):
		writeUplinkError(writer, http.StatusBadRequest)
	default:
		writeError(writer, http.StatusInternalServerError, "uplink request failed")
	}
}

func writeUplinkError(writer http.ResponseWriter, status int) {
	writeError(writer, status, "uplink request rejected")
}

func writeUplinkUnauthorized(writer http.ResponseWriter) {
	writer.Header().Set("WWW-Authenticate", `Bearer realm="miglens-uplink"`)
	writeUplinkError(writer, http.StatusUnauthorized)
}

func validUplinkIdentity(value string) bool {
	if value == "" || len(value) > 256 || !utf8.ValidString(value) || strings.TrimSpace(value) != value || strings.Contains(value, "*") {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func validUplinkToken(token string) bool {
	if len(token) < minimumUplinkTokenBytes || len(token) > maximumUplinkTokenBytes {
		return false
	}
	for _, character := range []byte(token) {
		if character < 0x21 || character > 0x7e {
			return false
		}
	}
	return true
}
