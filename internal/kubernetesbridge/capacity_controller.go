package kubernetesbridge

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/gpucapacity"
	corev1 "k8s.io/api/core/v1"
	resourcev1 "k8s.io/api/resource/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
)

type CapacityState struct {
	mu        sync.RWMutex
	document  gpucapacity.Document
	key       [32]byte
	revision  uint64
	cancel    context.CancelFunc
	computing bool
	compute   func(context.Context, CapacityInput, time.Time) gpucapacity.Document
}

func NewCapacityState() *CapacityState {
	return &CapacityState{document: gpucapacity.Unavailable("GPU capacity caches are synchronizing"), compute: BuildCapacity}
}

func (s *CapacityState) Document(now time.Time) gpucapacity.Document {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.document.At(now)
}

func (s *CapacityState) MarkUnavailable() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.revision++
	s.key, s.computing = [32]byte{}, false
	s.document = invalidateCapacity(s.document, "unavailable", "GPU capacity source is unavailable; reconnecting")
	s.document.Revision = s.revision
}

func (s *CapacityState) Observe(parent context.Context, input CapacityInput, observedAt time.Time) {
	// Do not partially sample a large reservation inventory: dropping even one
	// claim could inflate capacity. Bound evaluation work and report unknown.
	if len(input.Claims) > 20000 || len(input.Slices) > 4096 || len(input.Classes) > 1024 {
		s.MarkUnavailable()
		return
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		s.MarkUnavailable()
		return
	}
	key := sha256.Sum256(encoded)
	s.mu.Lock()
	if key == s.key {
		if s.computing {
			s.mu.Unlock()
			return
		}
		if s.document.Status == "available" || s.document.Status == "partial" || s.document.Status == "unsupported" {
			at := observedAt.UTC()
			s.document.ObservedAt = &at
			s.mu.Unlock()
			return
		}
	}
	if s.cancel != nil {
		s.cancel()
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	s.cancel, s.computing, s.key = cancel, true, key
	s.revision++
	revision := s.revision
	s.document = invalidateCapacity(s.document, "unavailable", "GPU capacity is updating")
	s.document.Revision = revision
	s.mu.Unlock()
	go func() {
		defer cancel()
		document := s.compute(ctx, input, observedAt)
		s.mu.Lock()
		defer s.mu.Unlock()
		// A superseded worker must never restore obsolete counts after a
		// reservation update or a failed watch.
		if revision != s.revision || parent.Err() != nil {
			return
		}
		if ctx.Err() != nil {
			document = invalidateCapacity(document, "unavailable", "GPU capacity evaluation exceeded its time limit")
		}
		document.Revision = revision
		s.document, s.computing, s.cancel = document, false, nil
	}()
}

// CapacityController owns independent, unfiltered ResourceClaim caches.
// Attribution remains namespace- and Coder-filtered and cannot supply this data.
type CapacityController struct {
	client  kubernetes.Interface
	state   *CapacityState
	options ControllerOptions
}

func NewCapacityController(client kubernetes.Interface, state *CapacityState, options ControllerOptions) (*CapacityController, error) {
	if client == nil || state == nil || options.NodeName == "" || options.Driver == "" || options.Now == nil || options.ProbeTimeout <= 0 || options.SyncTimeout <= 0 {
		return nil, errors.New("invalid GPU capacity controller options")
	}
	return &CapacityController{client: client, state: state, options: options}, nil
}

func (c *CapacityController) Run(ctx context.Context) error {
	defer c.state.MarkUnavailable()
	for {
		_ = c.runSession(ctx)
		if ctx.Err() != nil {
			return nil
		}
		c.state.MarkUnavailable()
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Second):
		}
	}
}

func (c *CapacityController) runSession(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	failed := make(chan struct{}, 1)
	var sourceMu sync.Mutex
	sourceFailed := false
	fail := func() {
		sourceMu.Lock()
		defer sourceMu.Unlock()
		if ctx.Err() == nil {
			sourceFailed = true
			c.state.MarkUnavailable()
			signal(failed)
		}
	}
	client := allocationClient{Interface: c.client, failed: fail}
	driverSelector := fields.OneTermEqualSelector("spec.driver", c.options.Driver).String()
	sliceFactory := informers.NewSharedInformerFactoryWithOptions(client, c.options.ResyncInterval, informers.WithTweakListOptions(func(o *metav1.ListOptions) { o.FieldSelector = driverSelector }))
	// No namespace or label selectors are permitted on these two sources.
	factory := informers.NewSharedInformerFactory(client, c.options.ResyncInterval)
	sliceInformer := sliceFactory.Resource().V1().ResourceSlices().Informer()
	claimInformer := factory.Resource().V1().ResourceClaims().Informer()
	classInformer := factory.Resource().V1().DeviceClasses().Informer()
	// Keep only fields used by device feasibility. The independent caches do
	// not retain workspace labels, claim specs, consumer identities, or opaque
	// driver parameters that may be present in arbitrary namespaces.
	if err := claimInformer.SetTransform(func(object any) (any, error) {
		if claim, ok := object.(*resourcev1.ResourceClaim); ok {
			copy := &resourcev1.ResourceClaim{ObjectMeta: metav1.ObjectMeta{Name: claim.Name, Namespace: claim.Namespace, UID: claim.UID, ResourceVersion: claim.ResourceVersion}}
			if claim.Status.Allocation != nil {
				copy.Status.Allocation = &resourcev1.AllocationResult{NodeSelector: claim.Status.Allocation.NodeSelector.DeepCopy(), Devices: resourcev1.DeviceAllocationResult{Results: claim.Status.Allocation.Devices.DeepCopy().Results}}
			}
			return copy, nil
		}
		return object, nil
	}); err != nil {
		return errors.New("configure capacity reservation cache")
	}
	if err := classInformer.SetTransform(func(object any) (any, error) {
		if class, ok := object.(*resourcev1.DeviceClass); ok {
			copy := &resourcev1.DeviceClass{ObjectMeta: metav1.ObjectMeta{Name: class.Name, ResourceVersion: class.ResourceVersion}, Spec: resourcev1.DeviceClassSpec{Selectors: append([]resourcev1.DeviceSelector{}, class.Spec.Selectors...), Config: make([]resourcev1.DeviceClassConfiguration, len(class.Spec.Config))}}
			return copy, nil
		}
		return object, nil
	}); err != nil {
		return errors.New("configure capacity DeviceClass cache")
	}
	updates := make(chan struct{}, 1)
	handler := cache.ResourceEventHandlerFuncs{AddFunc: func(any) { signal(updates) }, UpdateFunc: func(_, _ any) { signal(updates) }, DeleteFunc: func(any) { signal(updates) }}
	for _, informer := range []cache.SharedIndexInformer{sliceInformer, claimInformer, classInformer} {
		if err := informer.SetWatchErrorHandlerWithContext(func(context.Context, *cache.Reflector, error) { fail() }); err != nil {
			return err
		}
		if _, err := informer.AddEventHandler(handler); err != nil {
			return err
		}
	}
	sliceFactory.StartWithContext(ctx)
	factory.StartWithContext(ctx)
	syncCtx, stopSync := context.WithTimeout(ctx, c.options.SyncTimeout)
	synced := cache.WaitForCacheSync(syncCtx.Done(), sliceInformer.HasSynced, claimInformer.HasSynced, classInformer.HasSynced)
	stopSync()
	if !synced {
		return errors.New("GPU capacity caches did not synchronize")
	}
	node, err := c.probeCapacity(ctx, driverSelector)
	if err != nil {
		return err
	}
	observe := func() {
		input := capacityInputFromStores(node, c.options.Driver, sliceInformer, claimInformer, classInformer)
		sourceMu.Lock()
		defer sourceMu.Unlock()
		if !sourceFailed {
			c.state.Observe(ctx, input, c.options.Now())
		}
	}
	observe()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-failed:
			return errors.New("GPU capacity watch failed")
		case <-updates:
			observe()
		case <-ticker.C:
			node, err = c.probeCapacity(ctx, driverSelector)
			if err != nil {
				c.state.MarkUnavailable()
				return err
			}
			observe()
		}
	}
}

func (c *CapacityController) probeCapacity(parent context.Context, selector string) (*corev1.Node, error) {
	ctx, cancel := context.WithTimeout(parent, c.options.ProbeTimeout)
	defer cancel()
	if _, err := c.client.ResourceV1().ResourceSlices().List(ctx, metav1.ListOptions{FieldSelector: selector, Limit: 1}); err != nil {
		return nil, errors.New("GPU resource pools are unavailable")
	}
	if _, err := c.client.ResourceV1().ResourceClaims(metav1.NamespaceAll).List(ctx, metav1.ListOptions{Limit: 1}); err != nil {
		return nil, errors.New("GPU reservation information is unavailable")
	}
	if _, err := c.client.ResourceV1().DeviceClasses().List(ctx, metav1.ListOptions{Limit: 1}); err != nil {
		return nil, errors.New("GPU device classes are unavailable")
	}
	node, err := c.client.CoreV1().Nodes().Get(ctx, c.options.NodeName, metav1.GetOptions{})
	if err != nil {
		return nil, errors.New("Current-node information is unavailable")
	}
	return &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: node.Name, Labels: node.Labels, ResourceVersion: node.ResourceVersion}}, nil
}

func capacityInputFromStores(node *corev1.Node, driver string, slices, claims, classes cache.SharedIndexInformer) CapacityInput {
	input := CapacityInput{Node: node.DeepCopy(), Driver: driver}
	for _, object := range slices.GetStore().List() {
		if v, ok := object.(*resourcev1.ResourceSlice); ok {
			input.Slices = append(input.Slices, v.DeepCopy())
		}
	}
	for _, object := range claims.GetStore().List() {
		if v, ok := object.(*resourcev1.ResourceClaim); ok {
			input.Claims = append(input.Claims, v.DeepCopy())
		}
	}
	for _, object := range classes.GetStore().List() {
		if v, ok := object.(*resourcev1.DeviceClass); ok {
			input.Classes = append(input.Classes, v.DeepCopy())
		}
	}
	sort.Slice(input.Slices, func(i, j int) bool { return input.Slices[i].Name < input.Slices[j].Name })
	sort.Slice(input.Claims, func(i, j int) bool {
		a, b := input.Claims[i], input.Claims[j]
		return a.Namespace+"/"+a.Name < b.Namespace+"/"+b.Name
	})
	sort.Slice(input.Classes, func(i, j int) bool { return input.Classes[i].Name < input.Classes[j].Name })
	return input
}
