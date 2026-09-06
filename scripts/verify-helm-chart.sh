#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
chart="$repo_root/charts/leviathan-attribution"
helm_command=${HELM:-helm}

command -v "$helm_command" >/dev/null 2>&1 || {
  printf 'helm is required to verify the attribution chart\n' >&2
  exit 1
}
"$helm_command" lint "$chart" --kube-version 1.34.0 >/dev/null
rendered=$(mktemp)
workload_rendered=$(mktemp)
trap 'rm -f -- "$rendered" "$workload_rendered"' EXIT
"$helm_command" template synthetic "$chart" --namespace monitoring --kube-version 1.34.0 \
  --set-json 'workspaceNamespaces=["workspace-one","workspace-two"]' >"$rendered"

if grep -En '^[[:space:]]*(privileged:[[:space:]]*true|host(Network|PID|IPC):[[:space:]]*true)' "$rendered"; then
  printf 'bridge chart enables privileged host access\n' >&2
  exit 1
fi
if grep -Eni 'verbs:[[:space:]]*\[[^]]*(create|update|patch|delete|bind|escalate|impersonate|\*)' "$rendered"; then
  printf 'bridge chart grants mutating or wildcard RBAC verbs\n' >&2
  exit 1
fi
if grep -Eni 'resources:[[:space:]]*\[[^]]*(secrets|pods|nodes|serviceaccounts|roles|bindings|deployments|daemonsets|\*)' "$rendered"; then
  printf 'bridge chart grants unrelated or wildcard resources\n' >&2
  exit 1
fi
if grep -En '^[[:space:]]*nonResourceURLs:' "$rendered"; then
  printf 'bridge chart grants non-resource URL access\n' >&2
  exit 1
fi
if grep -E '^[[:space:]]*apiGroups:[[:space:]]*\[' "$rendered" | grep -Ev '^[[:space:]]*- apiGroups: \["resource.k8s.io"\]$'; then
  printf 'bridge chart grants an unexpected API group\n' >&2
  exit 1
fi
if grep -E '^[[:space:]]*resources:[[:space:]]*\[' "$rendered" | grep -Ev '^[[:space:]]+resources: \["(resourceslices|resourceclaims)"\]$'; then
  printf 'bridge chart grants an unexpected Kubernetes resource\n' >&2
  exit 1
fi
if grep -E '^[[:space:]]*verbs:[[:space:]]*\[' "$rendered" | grep -Ev '^[[:space:]]+verbs: \["get", "list", "watch"\]$'; then
  printf 'bridge chart grants verbs outside get/list/watch\n' >&2
  exit 1
fi
[[ $(grep -Ec '^kind: ClusterRole$' "$rendered") -eq 1 ]]
[[ $(grep -Ec '^kind: Role$' "$rendered") -eq 2 ]]
[[ $(grep -Ec 'resources: \["resourceslices"\]' "$rendered") -eq 1 ]]
[[ $(grep -Ec 'resources: \["resourceclaims"\]' "$rendered") -eq 2 ]]
grep -Eq 'readOnlyRootFilesystem: true' "$rendered"
grep -Eq 'allowPrivilegeEscalation: false' "$rendered"
grep -Eq 'type: RuntimeDefault' "$rendered"
grep -Eq 'drop:' "$rendered"
grep -Eq -- '- ALL' "$rendered"
grep -Eq -- '--socket=/run/leviathan/attribution.sock' "$rendered"
grep -Eq 'nvidia.com/gpu.present: "true"' "$rendered"
grep -Eq 'hostNetwork: false' "$rendered"
grep -Eq 'hostPID: false' "$rendered"
grep -Eq 'hostIPC: false' "$rendered"
if grep -E '^[[:space:]]*mountPath:' "$rendered" | grep -Ev '^[[:space:]]*mountPath: /run/leviathan$'; then
  printf 'bridge chart mounts an unexpected writable path\n' >&2
  exit 1
fi
[[ $(grep -Ec '^[[:space:]]*mountPath: /run/leviathan$' "$rendered") -eq 1 ]]
[[ $(grep -Ec '^[[:space:]]*path: /run/leviathan$' "$rendered") -eq 1 ]]
if grep -Eni '(/var/lib/kubelet|/(var/)?run/(containerd|docker|crio|k3s)|containerd\.sock|docker\.sock|crio\.sock)' "$rendered"; then
  printf 'bridge chart mounts a container-runtime path or socket\n' >&2
  exit 1
fi

if "$helm_command" template synthetic "$chart" --namespace monitoring --kube-version 1.34.0 \
  --set-json 'workspaceNamespaces=[]' >/dev/null 2>&1; then
  printf 'bridge chart accepted an empty workspaceNamespaces list\n' >&2
  exit 1
fi

# Pod inventory is an explicit namespace-scoped opt-in. The default rendering
# above continues to reject every Pod permission and every unrelated resource.
"$helm_command" template synthetic "$chart" --namespace monitoring --kube-version 1.34.0 \
  --set-json 'workspaceNamespaces=["workspace-one","workspace-two"]' \
  --set workloadInventory.enabled=true >"$workload_rendered"
[[ $(grep -Ec -- '--workload-inventory' "$workload_rendered") -eq 1 ]]
[[ $(grep -Ec 'resources: \["pods"\]' "$workload_rendered") -eq 2 ]]
if grep -E '^[[:space:]]*resources:[[:space:]]*\[' "$workload_rendered" | grep -Ev '^[[:space:]]+resources: \["(resourceslices|resourceclaims|pods)"\]$'; then
  printf 'workload opt-in grants resources outside the metadata inventory\n' >&2
  exit 1
fi
if grep -E '^[[:space:]]*verbs:[[:space:]]*\[' "$workload_rendered" | grep -Ev '^[[:space:]]+verbs: \["get", "list", "watch"\]$'; then
  printf 'workload opt-in grants non-read verbs\n' >&2
  exit 1
fi
if ! awk '/^kind:/ {kind=$2} /resources: \["pods"\]/ {if(kind!="Role") exit 1}' "$workload_rendered"; then
  printf 'workload Pod permissions must remain namespace-scoped\n' >&2
  exit 1
fi
if grep -Eni '(pods/(exec|log|attach)|secrets|privileged:[[:space:]]*true|host(Network|PID|IPC):[[:space:]]*true)' "$workload_rendered"; then
  printf 'workload inventory expands beyond metadata read permissions\n' >&2
  exit 1
fi
if "$helm_command" template synthetic "$chart" --namespace monitoring --kube-version 1.34.0 \
  --set-string 'socketPath=/run/containerd/containerd.sock' >/dev/null 2>&1; then
  printf 'bridge chart accepted a container-runtime socket path\n' >&2
  exit 1
fi

printf 'verified Helm chart: least-privilege default and optional Pod metadata RBAC\n'
