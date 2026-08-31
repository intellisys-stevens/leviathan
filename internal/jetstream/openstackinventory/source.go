// Package openstackinventory provides a project-scoped, read-only OpenStack
// Nova inventory source for the fleet controller.
package openstackinventory

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/gophercloud/gophercloud/v2"
	"github.com/gophercloud/gophercloud/v2/openstack"
	"github.com/gophercloud/gophercloud/v2/openstack/compute/v2/servers"
	tokens2 "github.com/gophercloud/gophercloud/v2/openstack/identity/v2/tokens"
	tokens3 "github.com/gophercloud/gophercloud/v2/openstack/identity/v3/tokens"
	"github.com/gophercloud/gophercloud/v2/pagination"
	"github.com/intellisys-stevens/leviathan/internal/fleet"
)

var canonicalServerUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

var (
	errInvalidServerResponse = errors.New("OpenStack returned an invalid server inventory response")
	errTenantMismatch        = errors.New("OpenStack returned an instance outside the configured project")
	errInstanceLimit         = errors.New("OpenStack instance inventory exceeded the configured limit")
	errResponseTooLarge      = errors.New("OpenStack response exceeded the configured limit")
)

const (
	// These are per-response limits. Nova pagination still applies MaxInstances,
	// but a byte limit is required before Gophercloud materializes a JSON page.
	maxAuthResponseBytes      = int64(2 << 20)
	maxInventoryResponseBytes = int64(16 << 20)
	novaFlavorMicroversion    = "2.47"
	maxFlavorCapacityValue    = int64(1<<31 - 1)
)

// CreatorResolver converts a Nova user ID into a trusted display username.
// The raw Nova ID is supplied only to this call and must not be assumed to be
// a username.
type CreatorResolver interface {
	ResolveCreator(context.Context, string) (string, error)
}

type CreatorResolverFunc func(context.Context, string) (string, error)

func (function CreatorResolverFunc) ResolveCreator(ctx context.Context, userID string) (string, error) {
	if function == nil {
		return "", nil
	}
	return function(ctx, userID)
}

// EmptyCreatorResolver is the safe default until a separately authorized,
// trusted identity lookup is configured.
type EmptyCreatorResolver struct{}

func (EmptyCreatorResolver) ResolveCreator(context.Context, string) (string, error) {
	return "", nil
}

type Source struct {
	compute         *gophercloud.ServiceClient
	projectID       string
	maxInstances    int
	creatorResolver CreatorResolver
	clock           func() time.Time
	consoleEnabled  bool
	maxConsoleBytes int64
}

var _ fleet.InventorySource = (*Source)(nil)

// novaServer is intentionally narrower than servers.Server. The standard JSON
// decoder skips every top-level field not listed here, so tags, AdminPass,
// fault details, keypair names, addresses, and response links never enter the
// adapter's retained representation.
type novaServer struct {
	ID       string          `json:"id"`
	TenantID string          `json:"tenant_id"`
	UserID   string          `json:"user_id"`
	Name     string          `json:"name"`
	Status   string          `json:"status"`
	Flavor   novaFlavor      `json:"flavor"`
	Metadata creatorMetadata `json:"metadata"`
}

// novaFlavor accepts the legacy ID-only server flavor and the bounded static
// capacity embedded by Nova compute microversion 2.47. Known Nova fields that
// are outside Yggdrasill's public inventory contract are decoded and dropped;
// unrecognized fields fail the inventory page atomically.
type novaFlavor struct {
	ID           string
	OriginalName string
	VCPUs        *int64
	RAMMiB       *int64
	RootDiskGiB  *int64
}

func (flavor *novaFlavor) UnmarshalJSON(data []byte) error {
	*flavor = novaFlavor{}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return errInvalidServerResponse
	}
	seen := make(map[string]struct{}, 12)
	for decoder.More() {
		keyToken, err := decoder.Token()
		key, ok := keyToken.(string)
		if err != nil || !ok {
			return errInvalidServerResponse
		}
		if _, duplicate := seen[key]; duplicate {
			return errInvalidServerResponse
		}
		seen[key] = struct{}{}

		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return errInvalidServerResponse
		}
		switch key {
		case "id":
			flavor.ID = decodedFlavorString(raw)
		case "original_name":
			flavor.OriginalName = decodedFlavorString(raw)
		case "vcpus":
			flavor.VCPUs = decodedFlavorCapacity(raw, 1)
		case "ram":
			flavor.RAMMiB = decodedFlavorCapacity(raw, 1)
		case "disk":
			flavor.RootDiskGiB = decodedFlavorCapacity(raw, 0)
		case "ephemeral", "swap", "rxtx_factor", "is_public", "extra_specs", "links":
			// These are documented flavor fields but are intentionally outside
			// the sanitized static-capacity projection.
		default:
			return errInvalidServerResponse
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return errInvalidServerResponse
	}
	if token, err := decoder.Token(); err != io.EOF || token != nil {
		return errInvalidServerResponse
	}
	return nil
}

func decodedFlavorString(raw json.RawMessage) string {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return value
}

func decodedFlavorCapacity(raw json.RawMessage, minimum int64) *int64 {
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil || value < minimum || value > maxFlavorCapacityValue {
		return nil
	}
	return &value
}

// creatorMetadata consumes the metadata object but retains only the one exact
// Exosphere key approved for creator attribution. Unknown values are discarded
// as they are decoded and are never copied into the fleet model.
type creatorMetadata struct {
	username string
}

func (metadata *creatorMetadata) UnmarshalJSON(data []byte) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok || delimiter != '{' {
		return errors.New("OpenStack server metadata must be an object")
	}
	for decoder.More() {
		keyToken, keyErr := decoder.Token()
		if keyErr != nil {
			return keyErr
		}
		key, ok := keyToken.(string)
		if !ok {
			return errors.New("OpenStack server metadata key is invalid")
		}
		if key == "exoCreatorUsername" {
			if err := decoder.Decode(&metadata.username); err != nil {
				return errors.New("OpenStack creator metadata is invalid")
			}
			continue
		}
		var discard json.RawMessage
		if err := decoder.Decode(&discard); err != nil {
			return err
		}
	}
	_, err = decoder.Token()
	return err
}

// NewFromEnv authenticates with the standard OS_* environment variables and
// returns a project-scoped Nova inventory source. It never parses or sources an
// OpenRC shell file.
func NewFromEnv(ctx context.Context, config Config) (*Source, error) {
	config, err := config.normalized()
	if err != nil {
		return nil, err
	}
	environment, err := environmentFromOS()
	if err != nil {
		return nil, err
	}
	if !containsExact(config.AllowedProjectIDs, environment.projectID) {
		return nil, errors.New("OS_PROJECT_ID is not allowlisted for OpenStack inventory")
	}
	authOptions, err := openstack.AuthOptionsFromEnv()
	if err != nil {
		return nil, errors.New("OpenStack authentication environment is incomplete or invalid")
	}
	authURL, err := validateHTTPSURL(authOptions.IdentityEndpoint, "auth", config.AllowedAuthHosts)
	if err != nil {
		return nil, err
	}

	// Force project scope from the explicitly required OS_PROJECT_ID and disable
	// Gophercloud's automatic reauthentication loop. The controller can rebuild
	// this source after a bounded failed refresh.
	authOptions.TenantID = environment.projectID
	authOptions.TenantName = ""
	authOptions.Scope = nil
	authOptions.AllowReauth = false

	provider, err := openstack.NewClient(authOptions.IdentityEndpoint)
	if err != nil {
		return nil, errors.New("OpenStack auth client initialization failed")
	}
	authBaseURL, err := validateHTTPSURL(provider.IdentityBase, "auth", config.AllowedAuthHosts)
	if err != nil {
		return nil, err
	}
	httpClient, securedTransport := securedHTTPClient(config, authURL, authBaseURL, environment.projectID)
	provider.HTTPClient = httpClient
	provider.UserAgent.Prepend("leviathan jetstream-inventory")
	if err := openstack.Authenticate(ctx, provider, authOptions); err != nil {
		return nil, safeOpenStackError("OpenStack authentication", err)
	}
	if !authenticatedForProject(provider, environment.projectID) {
		return nil, errors.New("OpenStack token project does not match OS_PROJECT_ID")
	}

	endpointOptions := gophercloud.EndpointOpts{
		Type:         "compute",
		Region:       environment.region,
		Version:      2,
		Availability: environment.availability,
	}
	rawComputeEndpoint, err := provider.EndpointLocator(endpointOptions)
	if err != nil {
		return nil, errors.New("OpenStack compute endpoint selection failed")
	}
	rawComputeURL, err := validateHTTPSURL(rawComputeEndpoint, "compute", config.AllowedComputeHosts)
	if err != nil {
		return nil, err
	}
	projectComputeURL, err := projectScopedComputeEndpoint(rawComputeURL, environment.projectID)
	if err != nil {
		return nil, err
	}
	compute, err := openstack.NewComputeV2(provider, endpointOptions)
	if err != nil {
		return nil, errors.New("OpenStack compute endpoint selection failed")
	}
	computeURL, err := validateHTTPSURL(compute.Endpoint, "compute", config.AllowedComputeHosts)
	if err != nil {
		return nil, err
	}
	if !sameSelectedComputeEndpoint(rawComputeURL, computeURL) {
		return nil, errors.New("OpenStack compute endpoint changed during selection")
	}
	selectedProjectComputeURL, err := projectScopedComputeEndpoint(computeURL, environment.projectID)
	if err != nil {
		return nil, err
	}
	if projectComputeURL.String() != selectedProjectComputeURL.String() {
		return nil, errors.New("OpenStack compute endpoint changed during selection")
	}
	// Some modern Nova catalogs publish only the version root. Scope that exact,
	// allowlisted endpoint to the authenticated project before any inventory URL
	// is constructed, preserving the transport's project-path pin.
	compute.Endpoint = projectComputeURL.String()
	if err := securedTransport.configureComputeEndpoint(projectComputeURL); err != nil {
		return nil, err
	}
	return newSource(compute, environment.projectID, config), nil
}

func newSource(compute *gophercloud.ServiceClient, projectID string, config Config) *Source {
	compute.Microversion = novaFlavorMicroversion
	return &Source{
		compute:         compute,
		projectID:       projectID,
		maxInstances:    config.MaxInstances,
		creatorResolver: config.CreatorResolver,
		clock:           config.Clock,
		consoleEnabled:  config.AllowConsoleOutput,
		maxConsoleBytes: config.MaxConsoleResponseBytes,
	}
}

// ReadConsole returns a bounded tail of a single project instance's Nova
// console. The transport permits only the exact os-getConsoleOutput action;
// every other compute mutation remains rejected before it reaches the network.
func (source *Source) ReadConsole(ctx context.Context, instanceUUID string, lines int) (string, error) {
	if source == nil || source.compute == nil {
		return "", errors.New("OpenStack inventory source is not initialized")
	}
	if !source.consoleEnabled {
		return "", errors.New("OpenStack console output is disabled")
	}
	if !canonicalServerUUID.MatchString(instanceUUID) {
		return "", errors.New("OpenStack console instance UUID is invalid")
	}
	if lines < 1 || lines > 200 {
		return "", errors.New("OpenStack console line count must be between 1 and 200")
	}
	output, err := servers.ShowConsoleOutput(ctx, source.compute, instanceUUID, servers.ShowConsoleOutputOpts{Length: lines}).Extract()
	if err != nil {
		return "", safeOpenStackError("OpenStack console output request", err)
	}
	if int64(len(output)) > source.maxConsoleBytes {
		return "", errors.New("OpenStack console output exceeded the configured response limit")
	}
	return output, nil
}

func authenticatedForProject(provider *gophercloud.ProviderClient, projectID string) bool {
	if provider == nil || projectID == "" {
		return false
	}
	switch result := provider.GetAuthResult().(type) {
	case tokens3.CreateResult:
		project, err := result.ExtractProject()
		return err == nil && project != nil && project.ID == projectID
	case tokens2.CreateResult:
		token, err := result.ExtractToken()
		return err == nil && token != nil && token.Tenant.ID == projectID
	default:
		return false
	}
}

// List implements fleet.InventorySource. It deliberately leaves AllTenants at
// its false zero value and validates every returned tenant before publishing a
// complete observation.
func (source *Source) List(ctx context.Context) (fleet.InventoryObservation, error) {
	if source == nil || source.compute == nil {
		return fleet.InventoryObservation{}, errors.New("OpenStack inventory source is not initialized")
	}
	instances := make([]fleet.Instance, 0)
	seen := make(map[string]struct{})
	creatorNames := make(map[string]string)
	marker := ""
	for {
		remaining := source.maxInstances - len(instances)
		pageServers, hasNextPage, err := source.listPage(ctx, remaining, marker)
		if err != nil {
			if errors.Is(err, errInvalidServerResponse) {
				return fleet.InventoryObservation{}, err
			}
			return fleet.InventoryObservation{}, safeOpenStackError("OpenStack instance inventory request", err)
		}
		if len(pageServers) == 0 && hasNextPage {
			return fleet.InventoryObservation{}, errInvalidServerResponse
		}
		if len(pageServers) == 0 {
			break
		}
		if len(pageServers) > remaining {
			return fleet.InventoryObservation{}, errInstanceLimit
		}
		for _, server := range pageServers {
			if server.TenantID == "" || server.TenantID != source.projectID {
				return fleet.InventoryObservation{}, errTenantMismatch
			}
			if !canonicalServerUUID.MatchString(server.ID) {
				return fleet.InventoryObservation{}, errInvalidServerResponse
			}
			if !validOpaqueIdentifier(server.UserID) {
				return fleet.InventoryObservation{}, errInvalidServerResponse
			}
			if _, duplicate := seen[server.ID]; duplicate {
				return fleet.InventoryObservation{}, errInvalidServerResponse
			}
			seen[server.ID] = struct{}{}

			creatorName, resolved := creatorNames[server.UserID]
			if !resolved {
				creatorName = source.resolveCreator(ctx, server.UserID)
				creatorNames[server.UserID] = creatorName
			}
			if creatorName == "" {
				creatorName = normalizedCreatorUsername(server.Metadata.username)
			}
			instances = append(instances, mapServer(server, creatorName))
		}
		if !hasNextPage {
			break
		}
		if len(instances) >= source.maxInstances {
			return fleet.InventoryObservation{}, errInstanceLimit
		}
		marker = pageServers[len(pageServers)-1].ID
	}
	observedAt := source.clock().UTC()
	return fleet.InventoryObservation{ObservedAt: observedAt, Instances: instances}, nil
}

// listPage fetches exactly one page. Pager.EachPage intentionally skips its
// callback for an empty page, which would hide an invalid empty page that still
// advertises a next link; constructing the exported page type lets us validate
// both fields atomically.
func (source *Source) listPage(ctx context.Context, limit int, marker string) ([]novaServer, bool, error) {
	query, err := (servers.ListOpts{Limit: limit, Marker: marker}).ToServerListQuery()
	if err != nil {
		return nil, false, errInvalidServerResponse
	}
	requestURL := source.compute.ServiceURL("servers", "detail") + query
	response, err := pagination.Request(ctx, source.compute, nil, requestURL)
	if err != nil {
		return nil, false, err
	}
	pageResult, err := pagination.PageResultFrom(response)
	if err != nil {
		if contextErr := ctx.Err(); contextErr != nil {
			return nil, false, contextErr
		}
		return nil, false, errInvalidServerResponse
	}
	page := servers.ServerPage{LinkedPageBase: pagination.LinkedPageBase{PageResult: pageResult}}
	if page.StatusCode == http.StatusNoContent {
		return []novaServer{}, false, nil
	}
	var pageServers []novaServer
	if err := servers.ExtractServersInto(page, &pageServers); err != nil {
		return nil, false, errInvalidServerResponse
	}
	nextURL, err := page.NextPageURL()
	if err != nil {
		return nil, false, errInvalidServerResponse
	}
	return pageServers, nextURL != "", nil
}

func (source *Source) resolveCreator(ctx context.Context, userID string) string {
	if !validOpaqueIdentifier(userID) || source.creatorResolver == nil {
		return ""
	}
	username, err := source.creatorResolver.ResolveCreator(ctx, userID)
	if err != nil {
		return ""
	}
	return normalizedCreatorUsername(username)
}

func normalizedCreatorUsername(value string) string {
	value = strings.TrimSpace(value)
	if !validDisplayToken(value, 256) {
		return ""
	}
	return value
}

func mapServer(server novaServer, creatorName string) fleet.Instance {
	rawState := normalizedRawState(server.Status)
	return fleet.Instance{
		UUID:            server.ID,
		Name:            sanitizedName(server.Name),
		CreatorUsername: creatorName,
		CreatorID:       server.UserID,
		CloudState:      fleet.NormalizeCloudState(rawState),
		RawCloudState:   rawState,
		Flavor:          flavorName(server.Flavor),
		Capacity:        flavorCapacity(server.Flavor),
	}
}

func flavorName(flavor novaFlavor) string {
	if name := flavorID(flavor.OriginalName); name != "" {
		return name
	}
	return flavorID(flavor.ID)
}

func flavorCapacity(flavor novaFlavor) *fleet.InstanceCapacity {
	if flavor.VCPUs == nil || flavor.RAMMiB == nil || flavor.RootDiskGiB == nil {
		return nil
	}
	return &fleet.InstanceCapacity{
		VCPUs:       *flavor.VCPUs,
		RAMMiB:      *flavor.RAMMiB,
		RootDiskGiB: *flavor.RootDiskGiB,
	}
}

func normalizedRawState(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if value == "" || len(value) > 64 {
		return "UNKNOWN"
	}
	for _, character := range value {
		if !(character >= 'A' && character <= 'Z') && !(character >= '0' && character <= '9') && character != '_' {
			return "UNKNOWN"
		}
	}
	return value
}

func flavorID(value string) string {
	if !validDisplayToken(value, 256) {
		return ""
	}
	return value
}

func sanitizedName(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "Unnamed instance"
	}
	var builder strings.Builder
	for _, character := range value {
		if unicode.IsControl(character) {
			builder.WriteRune(' ')
		} else {
			builder.WriteRune(character)
		}
		if builder.Len() >= 256 {
			break
		}
	}
	result := strings.Join(strings.Fields(builder.String()), " ")
	if result == "" {
		return "Unnamed instance"
	}
	return result
}

func projectScopedComputeEndpoint(endpoint *url.URL, projectID string) (*url.URL, error) {
	if endpoint == nil || !validURLPathSegment(projectID) {
		return nil, errors.New("OpenStack compute endpoint project is invalid")
	}
	basePath := strings.TrimSuffix(endpoint.Path, "/")
	separator := strings.LastIndexByte(basePath, '/')
	if separator < 0 {
		return nil, errors.New("OpenStack compute endpoint does not match OS_PROJECT_ID")
	}
	lastSegment := basePath[separator+1:]
	if isComputeV2Segment(lastSegment) {
		basePath += "/" + projectID
	} else if lastSegment == projectID {
		versionPath := basePath[:separator]
		versionSeparator := strings.LastIndexByte(versionPath, '/')
		if versionSeparator < 0 || !isComputeV2Segment(versionPath[versionSeparator+1:]) {
			return nil, errors.New("OpenStack compute endpoint does not match OS_PROJECT_ID")
		}
	} else {
		return nil, errors.New("OpenStack compute endpoint does not match OS_PROJECT_ID")
	}
	scoped := *endpoint
	scoped.Path = basePath + "/"
	return &scoped, nil
}

func isComputeV2Segment(value string) bool {
	return value == "v2" || value == "v2.1"
}

func validURLPathSegment(value string) bool {
	return validOpaqueIdentifier(value) && value != "." && value != ".." && url.PathEscape(value) == value
}

// Gophercloud normalizes a selected service endpoint by adding a trailing
// slash. Treat only that representation change (plus URL case-insensitive
// scheme and host casing) as equal before project scoping is applied.
func sameSelectedComputeEndpoint(first, second *url.URL) bool {
	if first == nil || second == nil {
		return false
	}
	return strings.EqualFold(first.Scheme, second.Scheme) &&
		strings.EqualFold(first.Host, second.Host) &&
		strings.TrimSuffix(first.Path, "/") == strings.TrimSuffix(second.Path, "/")
}

func exactAuthTokenPaths(authURL, authBaseURL *url.URL) map[string]struct{} {
	result := make(map[string]struct{}, 2)
	authPath := strings.TrimSuffix(authURL.Path, "/")
	switch {
	case strings.HasSuffix(authPath, "/v3"):
		result[authPath+"/auth/tokens"] = struct{}{}
	case strings.HasSuffix(authPath, "/v2.0"):
		result[authPath+"/tokens"] = struct{}{}
	default:
		basePath := strings.TrimSuffix(authBaseURL.Path, "/")
		result[basePath+"/v3/auth/tokens"] = struct{}{}
		result[basePath+"/v2.0/tokens"] = struct{}{}
	}
	return result
}

func securedHTTPClient(config Config, authURL, authBaseURL *url.URL, projectID string) (http.Client, *readOnlyTransport) {
	var client http.Client
	if config.HTTPClient != nil {
		client = *config.HTTPClient
	}
	if client.Transport == nil {
		client.Transport = http.DefaultTransport
	}
	transport := &readOnlyTransport{
		base:                      client.Transport,
		authHost:                  strings.ToLower(authURL.Host),
		authBasePath:              strings.TrimSuffix(authBaseURL.Path, "/"),
		authTokenPaths:            exactAuthTokenPaths(authURL, authBaseURL),
		allowedComputeHosts:       hostSet(config.AllowedComputeHosts),
		projectID:                 projectID,
		maxInstances:              config.MaxInstances,
		maxAuthResponseBytes:      maxAuthResponseBytes,
		maxInventoryResponseBytes: maxInventoryResponseBytes,
		allowConsoleOutput:        config.AllowConsoleOutput,
		maxConsoleResponseBytes:   config.MaxConsoleResponseBytes,
	}
	client.Transport = transport
	client.Timeout = config.RequestTimeout
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errors.New("OpenStack redirects are disabled")
	}
	return client, transport
}

type readOnlyTransport struct {
	base                http.RoundTripper
	authHost            string
	authBasePath        string
	authTokenPaths      map[string]struct{}
	allowedComputeHosts map[string]struct{}
	projectID           string
	computeHost         string
	computeBasePath     string
	maxInstances        int

	maxAuthResponseBytes      int64
	maxInventoryResponseBytes int64

	allowConsoleOutput      bool
	maxConsoleResponseBytes int64
}

func (transport *readOnlyTransport) configureComputeEndpoint(endpoint *url.URL) error {
	if transport == nil || endpoint == nil {
		return errors.New("OpenStack compute endpoint is invalid")
	}
	scopedEndpoint, err := projectScopedComputeEndpoint(endpoint, transport.projectID)
	if err != nil {
		return err
	}
	host := strings.ToLower(scopedEndpoint.Host)
	if _, allowed := transport.allowedComputeHosts[host]; !allowed {
		return errors.New("OpenStack compute endpoint host is not allowlisted")
	}
	basePath := strings.TrimSuffix(scopedEndpoint.Path, "/")
	if transport.computeHost != "" && (transport.computeHost != host || transport.computeBasePath != basePath) {
		return errors.New("OpenStack compute endpoint changed after authentication")
	}
	transport.computeHost = host
	transport.computeBasePath = basePath
	return nil
}

func (transport *readOnlyTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	responseLimit, err := transport.authorizedResponseLimit(request)
	if err != nil {
		return nil, err
	}
	if transport.base == nil {
		return nil, errors.New("OpenStack transport is not initialized")
	}
	response, err := transport.base.RoundTrip(request)
	if response != nil && response.Body != nil {
		response.Body = &boundedResponseBody{
			reader:     response.Body,
			closer:     response.Body,
			remaining:  responseLimit,
			limitError: errResponseTooLarge,
		}
	}
	return response, err
}

func (transport *readOnlyTransport) authorizedResponseLimit(request *http.Request) (int64, error) {
	if transport == nil {
		return 0, errors.New("OpenStack transport is not initialized")
	}
	if err := validateCanonicalRequest(request); err != nil {
		return 0, err
	}
	host := strings.ToLower(request.URL.Host)
	switch request.Method {
	case http.MethodGet, http.MethodHead:
		if host == transport.computeHost {
			if err := transport.validateInventoryRequest(request); err == nil {
				if transport.maxInventoryResponseBytes < 1 {
					return 0, errors.New("OpenStack transport response limit is invalid")
				}
				return transport.maxInventoryResponseBytes, nil
			}
		}
		// Authentication version discovery occurs before a compute endpoint is
		// configured. Once authenticated, this broad identity read is closed.
		if transport.computeHost == "" && host == transport.authHost && transport.isAuthDiscoveryRequest(request) {
			if transport.maxAuthResponseBytes < 1 {
				return 0, errors.New("OpenStack transport response limit is invalid")
			}
			return transport.maxAuthResponseBytes, nil
		}
		return 0, errors.New("OpenStack transport rejected a non-inventory request")
	case http.MethodPost:
		if transport.computeHost == "" && host == transport.authHost && transport.isAuthTokenRequest(request) {
			if transport.maxAuthResponseBytes < 1 {
				return 0, errors.New("OpenStack transport response limit is invalid")
			}
			return transport.maxAuthResponseBytes, nil
		}
		if host != transport.computeHost || !transport.allowConsoleOutput {
			return 0, errors.New("OpenStack transport rejected a non-read-only request")
		}
		if err := validateConsoleActionRequest(request, transport.computeBasePath); err != nil {
			return 0, err
		}
		if transport.maxConsoleResponseBytes < 1 {
			return 0, errors.New("OpenStack transport response limit is invalid")
		}
		return transport.maxConsoleResponseBytes, nil
	default:
		return 0, errors.New("OpenStack transport rejected a non-read-only request")
	}
}

func validateCanonicalRequest(request *http.Request) error {
	if request == nil || request.URL == nil || request.RequestURI != "" ||
		request.URL.User != nil || request.URL.Opaque != "" || request.URL.OmitHost ||
		request.URL.RawPath != "" || request.URL.RawFragment != "" || request.URL.Fragment != "" || request.URL.ForceQuery ||
		!strings.EqualFold(request.URL.Scheme, "https") || request.URL.Host == "" || request.URL.Hostname() == "" ||
		request.Host == "" || !strings.EqualFold(request.Host, request.URL.Host) {
		return errors.New("OpenStack transport rejected an invalid request URL")
	}
	requestPath := request.URL.Path
	if requestPath == "" || strings.Contains(requestPath, `\`) || strings.Contains(requestPath, "//") {
		return errors.New("OpenStack transport rejected an invalid request URL")
	}
	if (request.Method == http.MethodGet || request.Method == http.MethodHead) &&
		((request.Body != nil && request.Body != http.NoBody) || request.ContentLength != 0 || len(request.TransferEncoding) != 0) {
		return errors.New("OpenStack transport rejected an invalid read request")
	}
	pathForCleaning := requestPath
	if requestPath != "/" {
		pathForCleaning = strings.TrimSuffix(requestPath, "/")
	}
	if path.Clean(pathForCleaning) != pathForCleaning {
		return errors.New("OpenStack transport rejected an invalid request URL")
	}
	return nil
}

func (transport *readOnlyTransport) isAuthDiscoveryRequest(request *http.Request) bool {
	if request.URL.RawQuery != "" {
		return false
	}
	candidate := strings.TrimSuffix(request.URL.Path, "/")
	return candidate == transport.authBasePath
}

func (transport *readOnlyTransport) isAuthTokenRequest(request *http.Request) bool {
	if request.URL.RawQuery != "" {
		return false
	}
	_, allowed := transport.authTokenPaths[request.URL.Path]
	return allowed
}

func (transport *readOnlyTransport) validateInventoryRequest(request *http.Request) error {
	if transport.computeBasePath == "" || request.URL.Path != transport.computeBasePath+"/servers/detail" {
		return errors.New("OpenStack transport rejected an invalid inventory path")
	}
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil || len(query) < 1 || len(query) > 2 {
		return errors.New("OpenStack transport rejected an invalid inventory query")
	}
	limitValues, ok := query["limit"]
	if !ok || len(limitValues) != 1 {
		return errors.New("OpenStack transport rejected an invalid inventory query")
	}
	limit, err := strconv.Atoi(limitValues[0])
	if err != nil || limit < 1 || limit > transport.maxInstances {
		return errors.New("OpenStack transport rejected an invalid inventory query")
	}
	for key, values := range query {
		switch key {
		case "limit":
		case "marker":
			if len(values) != 1 || !canonicalServerUUID.MatchString(values[0]) {
				return errors.New("OpenStack transport rejected an invalid inventory query")
			}
		default:
			return errors.New("OpenStack transport rejected a non-project-scoped inventory query")
		}
	}
	return nil
}

const maxConsoleActionRequestBytes = 1024

func validateConsoleActionRequest(request *http.Request, computeBasePath string) error {
	if request.URL.RawQuery != "" || computeBasePath == "" {
		return errors.New("OpenStack transport rejected an invalid console action path")
	}
	prefix := computeBasePath + "/servers/"
	const suffix = "/action"
	if !strings.HasPrefix(request.URL.Path, prefix) || !strings.HasSuffix(request.URL.Path, suffix) {
		return errors.New("OpenStack transport rejected a non-read-only request")
	}
	instanceUUID := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, prefix), suffix)
	if !canonicalServerUUID.MatchString(instanceUUID) {
		return errors.New("OpenStack transport rejected a cross-project console action")
	}
	if request.Body == nil {
		return errors.New("OpenStack transport rejected an invalid console action body")
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxConsoleActionRequestBytes+1))
	_ = request.Body.Close()
	request.Body = io.NopCloser(bytes.NewReader(body))
	if err != nil || len(body) == 0 || len(body) > maxConsoleActionRequestBytes {
		return errors.New("OpenStack transport rejected an invalid console action body")
	}
	var action map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(&action); err != nil || len(action) != 1 {
		return errors.New("OpenStack transport rejected an invalid console action body")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("OpenStack transport rejected an invalid console action body")
	}
	raw, ok := action["os-getConsoleOutput"]
	if !ok {
		return errors.New("OpenStack transport rejected a non-read-only request")
	}
	var options map[string]json.RawMessage
	if err := json.Unmarshal(raw, &options); err != nil || len(options) != 1 {
		return errors.New("OpenStack transport rejected an invalid console action body")
	}
	rawLength, ok := options["length"]
	if !ok {
		return errors.New("OpenStack transport rejected an invalid console action body")
	}
	var lines int
	if err := json.Unmarshal(rawLength, &lines); err != nil || lines < 1 || lines > 200 {
		return errors.New("OpenStack transport rejected an invalid console action body")
	}
	return nil
}

type boundedResponseBody struct {
	reader     io.Reader
	closer     io.Closer
	remaining  int64
	exceeded   bool
	limitError error
}

func (body *boundedResponseBody) Read(buffer []byte) (int, error) {
	if body.exceeded {
		return 0, body.limitError
	}
	if body.remaining <= 0 {
		var probe [1]byte
		n, err := body.reader.Read(probe[:])
		if n > 0 {
			body.exceeded = true
			return 0, body.limitError
		}
		return 0, err
	}
	if int64(len(buffer)) > body.remaining {
		buffer = buffer[:body.remaining]
	}
	n, err := body.reader.Read(buffer)
	body.remaining -= int64(n)
	return n, err
}

func (body *boundedResponseBody) Close() error { return body.closer.Close() }

func hostSet(hosts []string) map[string]struct{} {
	result := make(map[string]struct{}, len(hosts))
	for _, host := range hosts {
		result[strings.ToLower(host)] = struct{}{}
	}
	return result
}

func safeOpenStackError(operation string, err error) error {
	var responseError gophercloud.ErrUnexpectedResponseCode
	if errors.As(err, &responseError) {
		return fmt.Errorf("%s failed with HTTP status %d", operation, responseError.Actual)
	}
	if errors.Is(err, context.Canceled) {
		return fmt.Errorf("%s canceled", operation)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s timed out", operation)
	}
	return fmt.Errorf("%s failed", operation)
}
