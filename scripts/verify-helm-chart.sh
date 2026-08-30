#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
chart="$repo_root/charts/miglens-attribution"
helm_command=${HELM:-helm}

command -v "$helm_command" >/dev/null 2>&1 || {
  printf 'helm is required to verify the attribution chart\n' >&2
  exit 1
}
command -v rg >/dev/null 2>&1 || {
  printf 'ripgrep is required to verify the attribution chart\n' >&2
  exit 1
}

"$helm_command" lint "$chart" --kube-version 1.34.0 >/dev/null
rendered=$(mktemp)
trap 'rm -f -- "$rendered"' EXIT
"$helm_command" template synthetic "$chart" --namespace monitoring --kube-version 1.34.0 \
  --set-json 'workspaceNamespaces=["workspace-one","workspace-two"]' >"$rendered"

if rg -n '^[[:space:]]*(privileged:[[:space:]]*true|host(Network|PID|IPC):[[:space:]]*true)' "$rendered"; then
  printf 'bridge chart enables privileged host access\n' >&2
  exit 1
fi
if rg -ni 'verbs:[[:space:]]*\[[^]]*(create|update|patch|delete|bind|escalate|impersonate|\*)' "$rendered"; then
  printf 'bridge chart grants mutating or wildcard RBAC verbs\n' >&2
  exit 1
fi
if rg -ni 'resources:[[:space:]]*\[[^]]*(secrets|pods|nodes|serviceaccounts|roles|bindings|deployments|daemonsets|\*)' "$rendered"; then
  printf 'bridge chart grants unrelated or wildcard resources\n' >&2
  exit 1
fi
if rg -n '^[[:space:]]*nonResourceURLs:' "$rendered"; then
  printf 'bridge chart grants non-resource URL access\n' >&2
  exit 1
fi
if rg '^[[:space:]]*apiGroups:[[:space:]]*\[' "$rendered" | rg -v '^[[:space:]]*- apiGroups: \["resource.k8s.io"\]$'; then
  printf 'bridge chart grants an unexpected API group\n' >&2
  exit 1
fi
if rg '^[[:space:]]*resources:[[:space:]]*\[' "$rendered" | rg -v '^[[:space:]]+resources: \["(resourceslices|resourceclaims)"\]$'; then
  printf 'bridge chart grants an unexpected Kubernetes resource\n' >&2
  exit 1
fi
if rg '^[[:space:]]*verbs:[[:space:]]*\[' "$rendered" | rg -v '^[[:space:]]+verbs: \["get", "list", "watch"\]$'; then
  printf 'bridge chart grants verbs outside get/list/watch\n' >&2
  exit 1
fi
[[ $(rg -c '^kind: ClusterRole$' "$rendered") -eq 1 ]]
[[ $(rg -c '^kind: Role$' "$rendered") -eq 2 ]]
[[ $(rg -c 'resources: \["resourceslices"\]' "$rendered") -eq 1 ]]
[[ $(rg -c 'resources: \["resourceclaims"\]' "$rendered") -eq 2 ]]
rg -q 'readOnlyRootFilesystem: true' "$rendered"
rg -q 'allowPrivilegeEscalation: false' "$rendered"
rg -q 'type: RuntimeDefault' "$rendered"
rg -q 'drop:' "$rendered"
rg -q -- '- ALL' "$rendered"
rg -q -- '--socket=/run/miglens/attribution.sock' "$rendered"
rg -q 'nvidia.com/gpu.present: "true"' "$rendered"
rg -q 'hostNetwork: false' "$rendered"
rg -q 'hostPID: false' "$rendered"
rg -q 'hostIPC: false' "$rendered"
if rg '^[[:space:]]*mountPath:' "$rendered" | rg -v '^[[:space:]]*mountPath: /run/miglens$'; then
  printf 'bridge chart mounts an unexpected writable path\n' >&2
  exit 1
fi
[[ $(rg -c '^[[:space:]]*mountPath: /run/miglens$' "$rendered") -eq 1 ]]
[[ $(rg -c '^[[:space:]]*path: /run/miglens$' "$rendered") -eq 1 ]]
if rg -ni '(/var/lib/kubelet|/(var/)?run/(containerd|docker|crio|k3s)|containerd\.sock|docker\.sock|crio\.sock)' "$rendered"; then
  printf 'bridge chart mounts a container-runtime path or socket\n' >&2
  exit 1
fi

if "$helm_command" template synthetic "$chart" --namespace monitoring --kube-version 1.34.0 \
  --set-json 'workspaceNamespaces=[]' >/dev/null 2>&1; then
  printf 'bridge chart accepted an empty workspaceNamespaces list\n' >&2
  exit 1
fi
if "$helm_command" template synthetic "$chart" --namespace monitoring --kube-version 1.34.0 \
  --set-string 'socketPath=/run/containerd/containerd.sock' >/dev/null 2>&1; then
  printf 'bridge chart accepted a container-runtime socket path\n' >&2
  exit 1
fi

printf 'verified Helm chart: least-privilege RBAC and hardened DaemonSet\n'
