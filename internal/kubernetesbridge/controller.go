package kubernetesbridge

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	resourcev1 "k8s.io/api/resource/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
)

type ControllerOptions struct {
	NodeName       string
	Namespaces     []string
	Driver         string
	SyncTimeout    time.Duration
	ResyncInterval time.Duration
	ProbeInterval  time.Duration
	ProbeTimeout   time.Duration
	Now            func() time.Time
	Logger         *slog.Logger
}

type Controller struct {
	client  kubernetes.Interface
	state   *State
	options ControllerOptions
}

func NewController(client kubernetes.Interface, state *State, options ControllerOptions) (*Controller, error) {
	if client == nil || state == nil {
		return nil, errors.New("Kubernetes client and attribution state are required")
	}
	options.NodeName = strings.TrimSpace(options.NodeName)
	options.Driver = strings.TrimSpace(options.Driver)
	if options.NodeName == "" || options.Driver == "" || len(options.Namespaces) == 0 || len(options.Namespaces) > 64 {
		return nil, errors.New("node name, driver, and at least one namespace are required")
	}
	if len(validation.IsDNS1123Subdomain(options.NodeName)) != 0 || len(validation.IsDNS1123Subdomain(options.Driver)) != 0 {
		return nil, errors.New("invalid node or DRA driver name")
	}
	unique := make(map[string]struct{}, len(options.Namespaces))
	namespaces := make([]string, 0, len(options.Namespaces))
	for _, namespace := range options.Namespaces {
		namespace = strings.TrimSpace(namespace)
		if namespace == "" || len(validation.IsDNS1123Label(namespace)) != 0 {
			return nil, errors.New("invalid Kubernetes namespace")
		}
		if _, exists := unique[namespace]; !exists {
			unique[namespace] = struct{}{}
			namespaces = append(namespaces, namespace)
		}
	}
	sort.Strings(namespaces)
	options.Namespaces = namespaces
	if options.SyncTimeout <= 0 || options.ResyncInterval <= 0 || options.ProbeInterval <= 0 || options.ProbeTimeout <= 0 || options.Now == nil {
		return nil, errors.New("invalid controller timing configuration")
	}
	if options.Logger == nil {
		options.Logger = slog.New(slog.DiscardHandler)
	}
	return &Controller{client: client, state: state, options: options}, nil
}

func DefaultControllerOptions(nodeName string, namespaces []string) ControllerOptions {
	return ControllerOptions{
		NodeName: nodeName, Namespaces: namespaces, Driver: "gpu.nvidia.com",
		SyncTimeout: 30 * time.Second, ResyncInterval: 30 * time.Second, ProbeInterval: 10 * time.Second, ProbeTimeout: 3 * time.Second,
		Now: func() time.Time { return time.Now().UTC() }, Logger: slog.Default(),
	}
}

func (c *Controller) Run(ctx context.Context) error {
	nodeSelector := fields.OneTermEqualSelector("spec.nodeName", c.options.NodeName).String()
	sliceFactory := informers.NewSharedInformerFactoryWithOptions(c.client, c.options.ResyncInterval,
		informers.WithTweakListOptions(func(options *metav1.ListOptions) {
			options.FieldSelector = nodeSelector
		}))
	sliceInformer := sliceFactory.Resource().V1().ResourceSlices().Informer()

	claimSelector := labels.Set{LabelCoderResource: "true"}.AsSelector().String()
	claimFactories := make([]informers.SharedInformerFactory, 0, len(c.options.Namespaces))
	claimInformers := make([]cache.SharedIndexInformer, 0, len(c.options.Namespaces))
	for _, namespace := range c.options.Namespaces {
		factory := informers.NewSharedInformerFactoryWithOptions(c.client, c.options.ResyncInterval,
			informers.WithNamespace(namespace),
			informers.WithTweakListOptions(func(options *metav1.ListOptions) {
				options.LabelSelector = claimSelector
			}))
		claimFactories = append(claimFactories, factory)
		claimInformers = append(claimInformers, factory.Resource().V1().ResourceClaims().Informer())
	}

	updates := make(chan struct{}, 1)
	handler := cache.ResourceEventHandlerFuncs{
		AddFunc:    func(any) { signal(updates) },
		UpdateFunc: func(_, _ any) { signal(updates) },
		DeleteFunc: func(any) { signal(updates) },
	}
	if _, err := sliceInformer.AddEventHandler(handler); err != nil {
		return fmt.Errorf("register ResourceSlice handler: %w", err)
	}
	for _, informer := range claimInformers {
		if _, err := informer.AddEventHandler(handler); err != nil {
			return fmt.Errorf("register ResourceClaim handler: %w", err)
		}
	}

	sliceFactory.StartWithContext(ctx)
	for _, factory := range claimFactories {
		factory.StartWithContext(ctx)
	}
	syncs := []cache.InformerSynced{sliceInformer.HasSynced}
	for _, informer := range claimInformers {
		syncs = append(syncs, informer.HasSynced)
	}
	syncContext, cancelSync := context.WithTimeout(ctx, c.options.SyncTimeout)
	synced := cache.WaitForCacheSync(syncContext.Done(), syncs...)
	cancelSync()
	if !synced {
		if ctx.Err() != nil {
			return nil
		}
		c.options.Logger.Error("Kubernetes attribution caches did not synchronize")
		return errors.New("Kubernetes attribution caches did not synchronize")
	}
	c.reconcile(sliceInformer, claimInformers, c.options.Now())

	ticker := time.NewTicker(c.options.ProbeInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-updates:
			c.reconcile(sliceInformer, claimInformers, c.options.Now())
		case <-ticker.C:
			if c.probe(ctx, nodeSelector, claimSelector) {
				c.reconcile(sliceInformer, claimInformers, c.options.Now())
			} else {
				c.state.MarkUnavailable()
			}
		}
	}
}

func (c *Controller) reconcile(sliceInformer cache.SharedIndexInformer, claimInformers []cache.SharedIndexInformer, observedAt time.Time) {
	slices := make([]*resourcev1.ResourceSlice, 0, len(sliceInformer.GetStore().List()))
	for _, object := range sliceInformer.GetStore().List() {
		if slice, ok := object.(*resourcev1.ResourceSlice); ok {
			slices = append(slices, slice.DeepCopy())
		}
	}
	claims := []*resourcev1.ResourceClaim{}
	for _, informer := range claimInformers {
		for _, object := range informer.GetStore().List() {
			if claim, ok := object.(*resourcev1.ResourceClaim); ok {
				claims = append(claims, claim.DeepCopy())
			}
		}
	}
	workloads, assignments, processScopes, stats := BuildInventory(claims, slices, c.options.NodeName, c.options.Driver)
	c.state.Update(workloads, assignments, processScopes, stats, observedAt)
	c.options.Logger.Info("attribution inventory updated",
		"workloads", len(workloads), "assignments", len(assignments), "processScopes", len(processScopes), "pendingClaims", stats.PendingClaims,
		"ambiguousProcessScopes", stats.AmbiguousProcessScopes, "invalidConsumers", stats.InvalidConsumers,
		"unresolved", stats.UnresolvedDevices, "invalidClaims", stats.InvalidClaims, "incompletePools", stats.IncompletePools)
}

func (c *Controller) probe(parent context.Context, nodeSelector, claimSelector string) bool {
	ctx, cancel := context.WithTimeout(parent, c.options.ProbeTimeout)
	defer cancel()
	if _, err := c.client.ResourceV1().ResourceSlices().List(ctx, metav1.ListOptions{FieldSelector: nodeSelector, Limit: 1}); err != nil {
		c.options.Logger.Warn("Kubernetes attribution source is unavailable", "resource", "ResourceSlice")
		return false
	}
	for _, namespace := range c.options.Namespaces {
		if _, err := c.client.ResourceV1().ResourceClaims(namespace).List(ctx, metav1.ListOptions{LabelSelector: claimSelector, Limit: 1}); err != nil {
			c.options.Logger.Warn("Kubernetes attribution source is unavailable", "resource", "ResourceClaim")
			return false
		}
	}
	return true
}

func signal(channel chan<- struct{}) {
	select {
	case channel <- struct{}{}:
	default:
	}
}
