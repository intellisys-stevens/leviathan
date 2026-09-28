package kubernetesbridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/gpucapacity"
	resourcev1 "k8s.io/api/resource/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes/fake"
	clienttesting "k8s.io/client-go/testing"
)

func waitCapacity(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("capacity state did not reach expected value")
}

func TestCapacityControllerReadsAllReservationsAndRecoversFromWatchFailure(t *testing.T) {
	input := capacityFixture()
	claim := &resourcev1.ResourceClaim{ObjectMeta: metav1.ObjectMeta{Name: "foreign-reservation", Namespace: "foreign-team"}, Status: resourcev1.ResourceClaimStatus{Allocation: &resourcev1.AllocationResult{Devices: resourcev1.DeviceAllocationResult{Results: []resourcev1.DeviceRequestAllocationResult{allocation(input.Driver, "private-local-pool", "private-mig-half-a")}}}}}
	objects := []runtime.Object{input.Node, claim}
	for _, s := range input.Slices {
		objects = append(objects, s)
	}
	for _, c := range input.Classes {
		objects = append(objects, c)
	}
	client := fake.NewClientset(objects...)
	stream := watch.NewRaceFreeFake()
	var watches atomic.Int32
	client.PrependWatchReactor("resourceclaims", func(action clienttesting.Action) (bool, watch.Interface, error) {
		if action.GetNamespace() != "" {
			t.Error("capacity watch was namespace scoped")
		}
		if watches.Add(1) == 1 {
			return true, stream, nil
		}
		return false, nil, nil
	})
	state := NewCapacityState()
	options := DefaultControllerOptions("node", []string{"coder-only"})
	options.ResyncInterval = time.Hour
	controller, err := NewCapacityController(client, state, options)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- controller.Run(ctx) }()
	defer func() { cancel(); <-done }()
	waitCapacity(t, func() bool { return state.Document(time.Now()).Status == "available" })
	expectCapacity(t, state.Document(time.Now()), 0, 0, 1)
	for _, action := range client.Actions() {
		if action.GetResource().Resource == "resourceclaims" && action.GetVerb() == "list" {
			list := action.(clienttesting.ListAction)
			if action.GetNamespace() != "" || !list.GetListRestrictions().Labels.Empty() {
				t.Fatal("capacity claim listing is filtered")
			}
		}
	}
	stream.Error(&metav1.Status{Reason: metav1.StatusReasonForbidden})
	waitCapacity(t, func() bool { return state.Document(time.Now()).Status != "available" })
	for _, row := range state.Document(time.Now()).Rows {
		if row.Available != nil {
			t.Fatal("failed watch retained an actionable count")
		}
	}
	if err := client.ResourceV1().ResourceClaims(claim.Namespace).Delete(ctx, claim.Name, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	waitCapacity(t, func() bool {
		d := state.Document(time.Now())
		return d.Status == "available" && d.Rows[0].Available != nil && *d.Rows[0].Available == 1
	})
	expectCapacity(t, state.Document(time.Now()), 1, 1, 2)
}

func TestCapacityLatestRevisionWinsAndObservationsExpire(t *testing.T) {
	state := NewCapacityState()
	oldStarted, releaseOld := make(chan struct{}), make(chan struct{})
	state.compute = func(ctx context.Context, input CapacityInput, at time.Time) gpucapacity.Document {
		if input.Node.ResourceVersion == "old" {
			close(oldStarted)
			<-releaseOld
		}
		return BuildCapacity(ctx, input, at)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	now := time.Now().UTC()
	old := capacityFixture()
	old.Node.ResourceVersion = "old"
	state.Observe(ctx, old, now)
	<-oldStarted
	next := capacityFixture()
	next.Node.ResourceVersion = "new"
	next.Claims = []*resourcev1.ResourceClaim{{Status: resourcev1.ResourceClaimStatus{Allocation: &resourcev1.AllocationResult{Devices: resourcev1.DeviceAllocationResult{Results: []resourcev1.DeviceRequestAllocationResult{allocation(next.Driver, "private-local-pool", "private-native")}}}}}}
	state.Observe(ctx, next, now)
	waitCapacity(t, func() bool { return state.Document(now).Status == "available" })
	current := state.Document(now)
	expectCapacity(t, current, 0, 0, 0)
	close(releaseOld)
	time.Sleep(20 * time.Millisecond)
	expectCapacity(t, state.Document(now), 0, 0, 0)
	if state.Document(now).Revision != current.Revision {
		t.Fatal("obsolete worker changed revision")
	}
	stale := state.Document(now.Add(16 * time.Second))
	if stale.Status != "stale" || stale.Rows[0].Available != nil {
		t.Fatal(stale)
	}
	state.Observe(ctx, next, now.Add(17*time.Second))
	fresh := state.Document(now.Add(17 * time.Second))
	expectCapacity(t, fresh, 0, 0, 0)
	if fresh.Revision != current.Revision {
		t.Fatal("unchanged source was recomputed")
	}
	state.MarkUnavailable()
	for _, row := range state.Document(now).Rows {
		if row.Available != nil {
			t.Fatal(row)
		}
	}
}

func TestCapacityPrivateRouteIsIndependentAndOptional(t *testing.T) {
	at := time.Now()
	state := NewState("test", "node", at)
	capacity := NewCapacityState()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	capacity.Observe(ctx, capacityFixture(), at)
	waitCapacity(t, func() bool { return capacity.Document(at).Status == "available" })
	for _, enabled := range []bool{false, true} {
		server := NewServer(state)
		if enabled {
			server.WithGPUCapacity(capacity)
		}
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/gpu-capacity", nil))
		if !enabled {
			if w.Code != 404 {
				t.Fatal(w.Code)
			}
			continue
		}
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(w)
		}
		var d gpucapacity.Document
		if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
			t.Fatal(err)
		}
		expectCapacity(t, d, 1, 1, 2)
		if state.Ready() {
			t.Fatal("capacity changed attribution readiness")
		}
	}
}
