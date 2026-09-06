package kubernetesbridge

import (
	"context"
	"sync"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
	resourceclient "k8s.io/client-go/kubernetes/typed/resource/v1"
	"k8s.io/client-go/util/watchlist"
)

// Reflector retries some in-stream ERROR events without invoking its error
// handler. Observe them at the typed watch boundary before a cache can appear
// fresh again. Error objects are not logged or forwarded to generic logging.
type allocationClient struct {
	kubernetes.Interface
	failed func()
}

func (c allocationClient) IsWatchListSemanticsUnSupported() bool {
	return watchlist.DoesClientNotSupportWatchListSemantics(c.Interface)
}
func (c allocationClient) ResourceV1() resourceclient.ResourceV1Interface {
	return allocationResourceClient{c.Interface.ResourceV1(), c.failed}
}

type allocationResourceClient struct {
	resourceclient.ResourceV1Interface
	failed func()
}

func (c allocationResourceClient) ResourceSlices() resourceclient.ResourceSliceInterface {
	return allocationSliceClient{c.ResourceV1Interface.ResourceSlices(), c.failed}
}
func (c allocationResourceClient) ResourceClaims(ns string) resourceclient.ResourceClaimInterface {
	return allocationClaimClient{c.ResourceV1Interface.ResourceClaims(ns), c.failed}
}

type allocationSliceClient struct {
	resourceclient.ResourceSliceInterface
	failed func()
}

func (c allocationSliceClient) Watch(ctx context.Context, o metav1.ListOptions) (watch.Interface, error) {
	w, err := c.ResourceSliceInterface.Watch(ctx, o)
	return guardAllocationWatch(ctx, w, err, c.failed)
}

type allocationClaimClient struct {
	resourceclient.ResourceClaimInterface
	failed func()
}

func (c allocationClaimClient) Watch(ctx context.Context, o metav1.ListOptions) (watch.Interface, error) {
	w, err := c.ResourceClaimInterface.Watch(ctx, o)
	return guardAllocationWatch(ctx, w, err, c.failed)
}

type allocationWatch struct {
	source watch.Interface
	events chan watch.Event
	done   chan struct{}
	once   sync.Once
}

func (w *allocationWatch) Stop()                          { w.once.Do(func() { close(w.done); w.source.Stop() }) }
func (w *allocationWatch) ResultChan() <-chan watch.Event { return w.events }
func guardAllocationWatch(ctx context.Context, source watch.Interface, err error, failed func()) (watch.Interface, error) {
	if err != nil {
		if ctx.Err() == nil {
			failed()
		}
		return nil, err
	}
	w := &allocationWatch{source: source, events: make(chan watch.Event), done: make(chan struct{})}
	go func() {
		defer close(w.events)
		defer w.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-w.done:
				return
			case event, ok := <-source.ResultChan():
				if !ok {
					return
				}
				if event.Type == watch.Error {
					if ctx.Err() == nil {
						failed()
					}
					return
				}
				select {
				case w.events <- event:
				case <-ctx.Done():
					return
				case <-w.done:
					return
				}
			}
		}
	}()
	return w, nil
}
