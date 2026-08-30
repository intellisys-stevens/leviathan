// Package openstackinventory provides a project-scoped, read-only OpenStack
// Nova inventory source for the fleet controller.
package openstackinventory

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/gophercloud/gophercloud/v2"
	"github.com/gophercloud/gophercloud/v2/openstack"
	"github.com/gophercloud/gophercloud/v2/openstack/compute/v2/servers"
	tokens2 "github.com/gophercloud/gophercloud/v2/openstack/identity/v2/tokens"
	tokens3 "github.com/gophercloud/gophercloud/v2/openstack/identity/v3/tokens"
	"github.com/gophercloud/gophercloud/v2/pagination"
	"github.com/intellisys-stevens/miglens/internal/fleet"
)

var canonicalServerUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

var (
	errInvalidServerResponse = errors.New("OpenStack returned an invalid server inventory response")
	errTenantMismatch        = errors.New("OpenStack returned an instance outside the configured project")
	errInstanceLimit         = errors.New("OpenStack instance inventory exceeded the configured limit")
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
}

var _ fleet.InventorySource = (*Source)(nil)

// novaServer is intentionally narrower than servers.Server. The standard JSON
// decoder skips every top-level field not listed here, so tags, AdminPass,
// fault details, keypair names, addresses, and response links never enter the
// adapter's retained representation.
type novaServer struct {
	ID       string `json:"id"`
	TenantID string `json:"tenant_id"`
	UserID   string `json:"user_id"`
	Name     string `json:"name"`
	Status   string `json:"status"`
	Flavor   struct {
		ID string `json:"id"`
	} `json:"flavor"`
	Metadata creatorMetadata `json:"metadata"`
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
	provider.HTTPClient = securedHTTPClient(config, authURL)
	provider.UserAgent.Prepend("miglens jetstream-inventory")
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
	if _, err := validateHTTPSURL(rawComputeEndpoint, "compute", config.AllowedComputeHosts); err != nil {
		return nil, err
	}
	compute, err := openstack.NewComputeV2(provider, endpointOptions)
	if err != nil {
		return nil, errors.New("OpenStack compute endpoint selection failed")
	}
	if _, err := validateHTTPSURL(compute.Endpoint, "compute", config.AllowedComputeHosts); err != nil {
		return nil, err
	}
	return newSource(compute, environment.projectID, config), nil
}

func newSource(compute *gophercloud.ServiceClient, projectID string, config Config) *Source {
	return &Source{
		compute:         compute,
		projectID:       projectID,
		maxInstances:    config.MaxInstances,
		creatorResolver: config.CreatorResolver,
		clock:           config.Clock,
	}
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
		var pageServers []novaServer
		hasNextPage := false
		pager := servers.List(source.compute, servers.ListOpts{Limit: remaining, Marker: marker})
		err := pager.EachPage(ctx, func(_ context.Context, page pagination.Page) (bool, error) {
			var extractErr error
			extractErr = servers.ExtractServersInto(page, &pageServers)
			if extractErr != nil {
				return false, errInvalidServerResponse
			}
			nextURL, nextErr := page.NextPageURL()
			if nextErr != nil {
				return false, errInvalidServerResponse
			}
			hasNextPage = nextURL != ""
			return false, nil
		})
		if err != nil {
			if errors.Is(err, errInvalidServerResponse) {
				return fleet.InventoryObservation{}, err
			}
			return fleet.InventoryObservation{}, safeOpenStackError("OpenStack instance inventory request", err)
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
		Flavor:          flavorID(server.Flavor.ID),
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

func securedHTTPClient(config Config, authURL *url.URL) http.Client {
	var client http.Client
	if config.HTTPClient != nil {
		client = *config.HTTPClient
	}
	if client.Transport == nil {
		client.Transport = http.DefaultTransport
	}
	client.Transport = &readOnlyTransport{
		base:         client.Transport,
		authHost:     strings.ToLower(authURL.Host),
		authHosts:    hostSet(config.AllowedAuthHosts),
		computeHosts: hostSet(config.AllowedComputeHosts),
	}
	client.Timeout = config.RequestTimeout
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errors.New("OpenStack redirects are disabled")
	}
	return client
}

type readOnlyTransport struct {
	base         http.RoundTripper
	authHost     string
	authHosts    map[string]struct{}
	computeHosts map[string]struct{}
}

func (transport *readOnlyTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL == nil || request.URL.User != nil || !strings.EqualFold(request.URL.Scheme, "https") {
		return nil, errors.New("OpenStack transport rejected a non-HTTPS request")
	}
	host := strings.ToLower(request.URL.Host)
	if request.URL.Query().Has("all_tenants") {
		return nil, errors.New("OpenStack transport rejected an all-tenants request")
	}
	_, authAllowed := transport.authHosts[host]
	_, computeAllowed := transport.computeHosts[host]
	switch request.Method {
	case http.MethodGet, http.MethodHead:
		if !authAllowed && !computeAllowed {
			return nil, errors.New("OpenStack transport rejected a non-allowlisted host")
		}
	case http.MethodPost:
		if host != transport.authHost || !authAllowed || !isTokenPath(request.URL.Path) {
			return nil, errors.New("OpenStack transport rejected a non-read-only request")
		}
	default:
		return nil, errors.New("OpenStack transport rejected a non-read-only request")
	}
	return transport.base.RoundTrip(request)
}

func isTokenPath(path string) bool {
	clean := strings.TrimSuffix(path, "/")
	return strings.HasSuffix(clean, "/auth/tokens") || strings.HasSuffix(clean, "/v2.0/tokens")
}

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
