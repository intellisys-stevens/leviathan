package kubernetesbridge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/attribution"
	"github.com/intellisys-stevens/leviathan/internal/model"
	"github.com/intellisys-stevens/leviathan/internal/workload"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	metadatafake "k8s.io/client-go/metadata/fake"
	clienttesting "k8s.io/client-go/testing"
)

func metadataPod(uid, workspace, owner string) *metav1.PartialObjectMetadata {
	return &metav1.PartialObjectMetadata{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Pod"}, ObjectMeta: metav1.ObjectMeta{UID: types.UID(uid), Name: "pod-" + workspace, Namespace: "synthetic-workspaces", Labels: map[string]string{LabelCoderResource: "true", LabelCoderWorkspaceID: workspace, LabelCoderWorkspaceName: "workspace-" + workspace, LabelCoderUserID: owner, LabelCoderUsername: "user-" + owner}, Annotations: map[string]string{"unrelated": "never-public"}}}
}

func TestWorkloadMetadataIncludesCPUOnlyAndHashesConsistently(t *testing.T) {
	at := time.Now().UTC()
	pod := metadataPod("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "workspace-id", "owner-id")
	second := pod.DeepCopy()
	second.UID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
	doc := BuildWorkloadInventory([]*metav1.PartialObjectMetadata{pod, second, pod}, at)
	if err := doc.Validate(); err != nil {
		t.Fatal(err)
	}
	if doc.Status != model.WorkloadTelemetryAvailable || len(doc.Owners) != 1 || len(doc.Pods) != 2 || len(doc.Owners[0].Workspaces) != 1 {
		t.Fatalf("document=%+v", doc)
	}
	scope, _ := attribution.ScopeRefForPodUID(string(pod.UID))
	if doc.Owners[0].Ref != HashRef("owner_", "owner-id") || doc.Owners[0].Workspaces[0].Ref != HashRef("workspace_", "workspace-id") {
		t.Fatal("inconsistent identity hashing")
	}
	found := false
	for _, p := range doc.Pods {
		found = found || p.ScopeRef == scope
	}
	if !found {
		t.Fatal("scope helper mismatch")
	}
	encoded, _ := json.Marshal(doc)
	for _, private := range []string{string(pod.UID), "never-public", "synthetic-workspaces", "\"owner-id\""} {
		if strings.Contains(string(encoded), private) {
			t.Fatalf("private identity escaped: %s", private)
		}
	}
}
func TestWorkloadMetadataConflictsDoNotChooseAnOwner(t *testing.T) {
	at := time.Now().UTC()
	pod := metadataPod("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "workspace-id", "owner-id")
	for name, mutate := range map[string]func(*metav1.PartialObjectMetadata){"workspace ownership": func(p *metav1.PartialObjectMetadata) {
		p.Labels[LabelCoderUserID] = "another-owner"
		p.Labels[LabelCoderUsername] = "another-user"
		p.UID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
	}, "scope ownership": func(p *metav1.PartialObjectMetadata) {
		p.Labels[LabelCoderWorkspaceID] = "different-workspace"
		p.Labels[LabelCoderWorkspaceName] = "different"
	}, "missing owner": func(p *metav1.PartialObjectMetadata) { delete(p.Labels, LabelCoderUserID) }} {
		t.Run(name, func(t *testing.T) {
			other := pod.DeepCopy()
			mutate(other)
			doc := BuildWorkloadInventory([]*metav1.PartialObjectMetadata{pod, other}, at)
			if doc.Status != model.WorkloadTelemetryPartial {
				t.Fatalf("conflict=%+v", doc)
			}
			if err := doc.Validate(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestWorkloadHandoffIsOptInAndPreservesAllocations(t *testing.T) {
	at := time.Now().UTC()
	state := NewState("test", "synthetic-node", at)
	server := NewServer(state)
	request := httptest.NewRequest(http.MethodGet, "/v1/workloads", nil)
	writer := httptest.NewRecorder()
	server.Handler().ServeHTTP(writer, request)
	if writer.Code != http.StatusNotFound {
		t.Fatal("Pod handoff enabled without opt in")
	}
	podState := NewWorkloadState(at)
	podState.Update(BuildWorkloadInventory([]*metav1.PartialObjectMetadata{metadataPod("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "work", "owner")}, at))
	server.WithWorkloads(podState)
	writer = httptest.NewRecorder()
	server.Handler().ServeHTTP(writer, request)
	var doc workload.Document
	if writer.Code != http.StatusOK || json.Unmarshal(writer.Body.Bytes(), &doc) != nil || doc.Validate() != nil {
		t.Fatalf("handoff=%s", writer.Body.String())
	}
	allocations := httptest.NewRecorder()
	server.Handler().ServeHTTP(allocations, httptest.NewRequest(http.MethodGet, "/v1/allocations", nil))
	var legacy attribution.Document
	if json.Unmarshal(allocations.Body.Bytes(), &legacy) != nil || legacy.SchemaVersion != attribution.SchemaVersion || len(legacy.Workloads) != 0 {
		t.Fatal("Pod inventory altered GPU allocation document")
	}
}
func TestWorkloadListUsesMetadataNodeAndCoderSelectors(t *testing.T) {
	scheme := runtime.NewScheme()
	metav1.AddMetaToScheme(scheme)
	client := metadatafake.NewSimpleMetadataClient(scheme, metadataPod("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "work", "owner"))
	options := DefaultControllerOptions("synthetic-node", []string{"synthetic-workspaces"})
	controller, err := NewWorkloadController(client, NewWorkloadState(time.Now()), options)
	if err != nil {
		t.Fatal(err)
	}
	pods, err := controller.list(context.Background(), "spec.nodeName=synthetic-node", LabelCoderResource+"=true")
	if err != nil || len(pods) != 1 {
		t.Fatalf("pods=%d err=%v", len(pods), err)
	}
	for _, action := range client.Actions() {
		list := action.(clienttesting.ListAction)
		if list.GetResource().Resource != "pods" || list.GetNamespace() != "synthetic-workspaces" || list.GetListRestrictions().Fields.String() != "spec.nodeName=synthetic-node" || list.GetListRestrictions().Labels.String() != LabelCoderResource+"=true" {
			t.Fatalf("unexpected metadata action: %+v", action)
		}
	}
}

func TestWorkloadControllerRecoversPodPermissionFailureIndependently(t *testing.T) {
	scheme := runtime.NewScheme()
	metav1.AddMetaToScheme(scheme)
	client := metadatafake.NewSimpleMetadataClient(scheme, metadataPod("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "work", "owner"))
	var fail atomic.Bool
	client.PrependReactor("list", "pods", func(clienttesting.Action) (bool, runtime.Object, error) {
		if fail.Load() {
			return true, nil, errors.New("forbidden")
		}
		return false, nil, nil
	})
	options := DefaultControllerOptions("synthetic-node", []string{"synthetic-workspaces"})
	options.ProbeInterval = 25 * time.Millisecond
	state := NewWorkloadState(time.Now())
	controller, err := NewWorkloadController(client, state, options)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- controller.Run(ctx) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	wait := func(want model.WorkloadTelemetryStatus) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if state.Document(time.Now()).Status == want {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("inventory did not reach %s", want)
	}
	wait(model.WorkloadTelemetryAvailable)
	fail.Store(true)
	wait(model.WorkloadTelemetryStale)
	fail.Store(false)
	wait(model.WorkloadTelemetryAvailable)
	for _, action := range client.Actions() {
		if action.GetVerb() != "list" && action.GetVerb() != "watch" {
			t.Fatalf("unexpected Pod mutation: %s", action.GetVerb())
		}
		if action.GetResource() != podsResource {
			t.Fatal("controller accessed another resource")
		}
	}
}
