package kubernetesbridge

import (
	"context"
	"k8s.io/apimachinery/pkg/watch"
	clienttesting "k8s.io/client-go/testing"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	resourcev1 "k8s.io/api/resource/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
)

func TestControllerBuildsInventoryFromWatches(t *testing.T) {
	node := "synthetic-node"
	objects := []runtime.Object{
		resourceSlice(node, "gpu.nvidia.com", "pool", 1, 1, device("device", "MIG-synthetic-controller", "mig")),
		resourceClaim("workspace", "synthetic-workspace", "synthetic-owner", true,
			allocation("gpu.nvidia.com", "pool", "device")),
	}
	client := fake.NewClientset(objects...)
	at := time.Unix(1_700_000_000, 0).UTC()
	state := newStateWithInstance("test", node, "instance_11111111111111111111111111111111", at)
	options := DefaultControllerOptions(node, []string{"synthetic-workspaces"})
	options.ResyncInterval = time.Hour
	options.ProbeInterval = time.Hour
	options.Now = func() time.Time { return at }
	options.Logger = slog.New(slog.DiscardHandler)
	controller, err := NewController(client, state, options)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- controller.Run(ctx) }()
	deadline := time.Now().Add(3 * time.Second)
	for !state.Ready() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !state.Ready() {
		cancel()
		<-done
		t.Fatal("controller caches did not become ready")
	}
	document := state.Document(at)
	if len(document.Workloads) != 1 || len(document.Assignments) != 1 || len(document.ProcessScopes) != 1 || document.Assignments[0].EntityUUID != "MIG-synthetic-controller" {
		t.Fatalf("controller document = %+v", document)
	}
	if err := client.ResourceV1().ResourceClaims("synthetic-workspaces").Delete(ctx, "synthetic-claim-"+HashRef("", "workspace"), metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		document = state.Document(at)
		if len(document.Workloads) == 0 && len(document.Assignments) == 0 && len(document.ProcessScopes) == 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if len(document.Workloads) != 0 || len(document.Assignments) != 0 || len(document.ProcessScopes) != 0 {
		t.Fatalf("deleted claim remained in controller document: %+v", document)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

var _ = resourcev1.SchemeGroupVersion

func TestWatchFailureInvalidatesInventoryUntilFreshResync(t *testing.T) {
	c, slices := dynamicInventoryFixture()
	client := fake.NewClientset(c, slices[0])
	stream := watch.NewRaceFreeFake()
	var calls atomic.Int32
	client.PrependWatchReactor("resourceclaims", func(action clienttesting.Action) (bool, watch.Interface, error) {
		if calls.Add(1) == 1 {
			return true, stream, nil
		}
		return false, nil, nil
	})
	state := NewState("test", "node", time.Now())
	options := DefaultControllerOptions("node", []string{c.Namespace})
	options.ProbeInterval = time.Hour
	options.ResyncInterval = time.Hour
	options.Logger = slog.New(slog.DiscardHandler)
	controller, err := NewController(client, state, options)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- controller.Run(ctx) }()
	wait := func(predicate func() bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if predicate() {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatal("controller state did not converge")
	}
	wait(state.Ready)
	c.Labels[LabelCoderWorkspaceName] = "updated-after-disconnect"
	if _, err = client.ResourceV1().ResourceClaims(c.Namespace).Update(ctx, c, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	stream.Error(&metav1.Status{Status: "Failure", Reason: metav1.StatusReasonForbidden, Code: 403})
	wait(func() bool { return !state.Ready() })
	wait(func() bool {
		d := state.DocumentV2(time.Now())
		return state.Ready() && len(d.Workloads) == 1 && d.Workloads[0].Name == "updated-after-disconnect" && len(d.Bindings) == 2
	})
	cancel()
	if err = <-done; err != nil {
		t.Fatal(err)
	}
}
