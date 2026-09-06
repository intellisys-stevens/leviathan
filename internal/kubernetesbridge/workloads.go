package kubernetesbridge

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/attribution"
	"github.com/intellisys-stevens/leviathan/internal/model"
	"github.com/intellisys-stevens/leviathan/internal/workload"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/metadata"
)

const LabelCoderUserID = "com.coder.user.id"

type WorkloadState struct {
	mu       sync.RWMutex
	document workload.Document
}

func NewWorkloadState(now time.Time) *WorkloadState {
	return &WorkloadState{document: workload.Document{SchemaVersion: workload.SchemaVersion, GeneratedAt: now, ObservedAt: now, Status: model.WorkloadTelemetryUnavailable, Message: "Workspace metadata inventory is synchronizing", Owners: []workload.Owner{}, Pods: []workload.Pod{}}}
}
func (s *WorkloadState) Update(document workload.Document) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.document = document
}
func (s *WorkloadState) MarkUnavailable() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.document.Status = model.WorkloadTelemetryStale
	s.document.Message = "Workspace metadata source is unavailable; check Pod permissions"
}
func (s *WorkloadState) Document(now time.Time) workload.Document {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := s.document
	result.GeneratedAt = now
	return result
}

// BuildWorkloadInventory joins metadata only. Any ownership conflict makes the
// complete inventory partial, so a missing Pod cannot masquerade as owner zero.
func BuildWorkloadInventory(pods []*metav1.PartialObjectMetadata, at time.Time) workload.Document {
	document := workload.Document{SchemaVersion: workload.SchemaVersion, GeneratedAt: at, ObservedAt: at, Status: model.WorkloadTelemetryAvailable, Owners: []workload.Owner{}, Pods: []workload.Pod{}}
	owners := map[string]workload.Owner{}
	workspaces := map[string]model.WorkloadAttribution{}
	workspaceOwners := map[string]string{}
	scopes := map[string]workload.Pod{}
	invalidOwners := map[string]bool{}
	invalidWorkspaces := map[string]bool{}
	invalidScopes := map[string]bool{}
	partial := false
	for _, pod := range pods {
		if pod == nil {
			partial = true
			continue
		}
		if pod.Labels[LabelCoderResource] != "true" {
			continue
		}
		ownerID := strings.TrimSpace(pod.Labels[LabelCoderUserID])
		name := strings.TrimSpace(pod.Labels[LabelCoderUsername])
		workspaceID := strings.TrimSpace(pod.Labels[LabelCoderWorkspaceID])
		workspaceName := strings.TrimSpace(pod.Labels[LabelCoderWorkspaceName])
		scope, ok := attribution.ScopeRefForPodUID(string(pod.UID))
		if !ok || !safeDisplay(ownerID, 253) || !safeDisplay(name, 128) || !safeDisplay(workspaceID, 253) || !safeDisplay(workspaceName, 253) {
			partial = true
			continue
		}
		ownerRef := HashRef("owner_", ownerID)
		workspaceRef := HashRef("workspace_", workspaceID)
		w := model.WorkloadAttribution{Ref: workspaceRef, Platform: model.WorkloadPlatformCoder, Kind: model.WorkloadKindWorkspace, Name: workspaceName, OwnerName: name}
		if existing, ok := owners[ownerRef]; ok && existing.Name != name {
			invalidOwners[ownerRef] = true
			partial = true
		}
		if existing, ok := workspaces[workspaceRef]; ok && (existing != w || workspaceOwners[workspaceRef] != ownerRef) {
			invalidWorkspaces[workspaceRef] = true
			partial = true
		}
		p := workload.Pod{ScopeRef: scope, OwnerRef: ownerRef, WorkloadRef: workspaceRef}
		if existing, ok := scopes[scope]; ok && existing != p {
			invalidScopes[scope] = true
			partial = true
		}
		owners[ownerRef] = workload.Owner{Ref: ownerRef, Name: name, Platform: model.WorkloadPlatformCoder, Workspaces: []model.WorkloadAttribution{}}
		workspaces[workspaceRef] = w
		workspaceOwners[workspaceRef] = ownerRef
		scopes[scope] = p
	}
	for _, w := range workspaces {
		ownerRef := workspaceOwners[w.Ref]
		if invalidOwners[ownerRef] || invalidWorkspaces[w.Ref] {
			continue
		}
		owner := owners[ownerRef]
		owner.Workspaces = append(owner.Workspaces, w)
		owners[ownerRef] = owner
	}
	for _, owner := range owners {
		if invalidOwners[owner.Ref] || len(owner.Workspaces) == 0 {
			continue
		}
		sort.Slice(owner.Workspaces, func(i, j int) bool { return owner.Workspaces[i].Ref < owner.Workspaces[j].Ref })
		document.Owners = append(document.Owners, owner)
	}
	for _, pod := range scopes {
		if !invalidScopes[pod.ScopeRef] && !invalidOwners[pod.OwnerRef] && !invalidWorkspaces[pod.WorkloadRef] {
			document.Pods = append(document.Pods, pod)
		}
	}
	sort.Slice(document.Owners, func(i, j int) bool { return document.Owners[i].Ref < document.Owners[j].Ref })
	sort.Slice(document.Pods, func(i, j int) bool { return document.Pods[i].ScopeRef < document.Pods[j].ScopeRef })
	if partial {
		document.Status = model.WorkloadTelemetryPartial
		document.Message = "Partial: missing or conflicting Coder ownership labels"
	}
	if err := document.Validate(); err != nil {
		document.Owners = []workload.Owner{}
		document.Pods = []workload.Pod{}
		document.Status = model.WorkloadTelemetryUnavailable
		document.Message = "Workspace metadata inventory exceeds its safety bounds"
	}
	return document
}

type WorkloadController struct {
	client  metadata.Interface
	state   *WorkloadState
	options ControllerOptions
}

func NewWorkloadController(client metadata.Interface, state *WorkloadState, options ControllerOptions) (*WorkloadController, error) {
	if client == nil || state == nil || options.NodeName == "" || len(options.Namespaces) == 0 || options.Now == nil || options.ProbeInterval <= 0 || options.ProbeTimeout <= 0 {
		return nil, errors.New("invalid workspace metadata controller options")
	}
	return &WorkloadController{client: client, state: state, options: options}, nil
}

var podsResource = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}

func (c *WorkloadController) Run(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	updates := make(chan struct{}, 1)
	nodeSelector := fields.OneTermEqualSelector("spec.nodeName", c.options.NodeName).String()
	labelSelector := labels.Set{LabelCoderResource: "true"}.AsSelector().String()
	for _, namespace := range c.options.Namespaces {
		workers.Add(1)
		go func(namespace string) {
			defer workers.Done()
			c.watch(ctx, namespace, nodeSelector, labelSelector, updates)
		}(namespace)
	}

	refresh := func() {
		pods, err := c.list(ctx, nodeSelector, labelSelector)
		if err != nil {
			c.state.MarkUnavailable()
			return
		}
		c.state.Update(BuildWorkloadInventory(pods, c.options.Now()))
	}
	refresh()
	ticker := time.NewTicker(c.options.ProbeInterval)
	defer ticker.Stop()
	// Watch events prompt a bounded authoritative metadata list. Independent
	// successful reads, not activity in another namespace's cache, refresh age.
	var lastEvent time.Time
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			refresh()
		case <-updates:
			if delay := time.Until(lastEvent.Add(500 * time.Millisecond)); delay > 0 {
				timer := time.NewTimer(delay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return nil
				case <-timer.C:
				}
			}
			refresh()
			lastEvent = time.Now()
		}
	}
}

// Watches are event signals, not retained stores: an oversized source cannot
// allocate an unbounded informer cache before the bounded authoritative list.
func (c *WorkloadController) watch(ctx context.Context, namespace, nodeSelector, labelSelector string, updates chan<- struct{}) {
	for ctx.Err() == nil {
		timeout := int64(300)
		stream, err := c.client.Resource(podsResource).Namespace(namespace).Watch(ctx, metav1.ListOptions{FieldSelector: nodeSelector, LabelSelector: labelSelector, AllowWatchBookmarks: true, TimeoutSeconds: &timeout})
		if err == nil {
			running := true
			for running {
				select {
				case <-ctx.Done():
					stream.Stop()
					return
				case event, ok := <-stream.ResultChan():
					if !ok {
						running = false
						break
					}
					if event.Type == watch.Error {
						running = false
						break
					}
					if event.Type != watch.Bookmark {
						signal(updates)
					}
				}
			}
			stream.Stop()
		}
		signal(updates)
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (c *WorkloadController) list(parent context.Context, nodeSelector, labelSelector string) ([]*metav1.PartialObjectMetadata, error) {
	ctx, cancel := context.WithTimeout(parent, c.options.ProbeTimeout)
	defer cancel()
	pods := []*metav1.PartialObjectMetadata{}
	for _, namespace := range c.options.Namespaces {
		continuation := ""
		for page := 0; page < 64; page++ {
			list, err := c.client.Resource(podsResource).Namespace(namespace).List(ctx, metav1.ListOptions{FieldSelector: nodeSelector, LabelSelector: labelSelector, Limit: 256, Continue: continuation})
			if err != nil {
				return nil, err
			}
			for i := range list.Items {
				pods = append(pods, &list.Items[i])
				if len(pods) > workload.MaxPods {
					return nil, errors.New("Pod inventory exceeds bound")
				}
			}
			continuation = list.Continue
			if continuation == "" {
				break
			}
			if page == 63 {
				return nil, errors.New("Pod pagination exceeds bound")
			}
		}
	}
	return pods, nil
}
