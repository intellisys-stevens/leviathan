#!/usr/bin/env bash
set -euo pipefail

umask 077

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
service_template="${repository_root}/contrib/systemd/leviathan-uplink@.service"

action=
state_url=${LEVIATHAN_BOOTSTRAP_STATE_URL:-http://127.0.0.1:1398/api/fleet/v1/state}
uplink_url=${LEVIATHAN_BOOTSTRAP_UPLINK_URL:-}
instance_uuid=
creator_username=
ssh_host=
ssh_user=exouser
identity_file=
binary_path=
binary_sha256=
binary_architecture=
token_keychain_service=
token_from_stdin=false
uplink_token=
verify_timeout=90
apply_changes=false

state_file=
metadata_file=
remote_temporary=
ssh_target=
ssh_options=(-o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new)

usage() {
  cat <<'EOF'
Safely bootstrap Leviathan Uplink on an explicitly selected Jetstream instance.

Usage:
  bootstrap-jetstream-uplink.sh list [--state-url URL]
  bootstrap-jetstream-uplink.sh install [options]

The install command is read-only by default. It validates Yggdrasil policy, the SSH
target's OpenStack metadata UUID, the remote user and architecture, and the
local binary. Add --apply only after reviewing that plan.

Required install options:
  --instance-uuid UUID          Exact Nova instance UUID
  --creator-username USER       Exact creator label reported by Yggdrasil
  --host HOST                   Exact SSH hostname or IPv4 address
  --binary PATH                 Local Linux Leviathan binary
  --binary-sha256 SHA256        Expected SHA-256 of that binary
  --binary-arch amd64|arm64     Architecture of that binary
  --uplink-url HTTPS_ORIGIN     Public HTTPS origin of Yggdrasil's uplink listener

Required token source (choose exactly one):
  --token-keychain-service NAME macOS Keychain service holding the creator token
  --token-stdin                 Read the creator token from stdin during --apply

Optional install options:
  --ssh-user USER               SSH and collector account (default: exouser)
  --identity-file PATH          Explicit SSH private key
  --state-url URL               Fleet state endpoint
  --verify-timeout SECONDS      Yggdrasil acknowledgement timeout (default: 90)
  --apply                       Perform installation after all preflight checks
  -h, --help                    Show this help

Environment defaults:
  LEVIATHAN_BOOTSTRAP_STATE_URL
  LEVIATHAN_BOOTSTRAP_UPLINK_URL

The token is used only during --apply and is streamed over SSH through stdin.
It is never placed in a command argument, exported environment, temporary file,
or log. Dry runs never read the selected token source.
EOF
}

fail() {
  printf 'Jetstream bootstrap: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

cleanup() {
  local exit_status=$?
  trap - EXIT

  if [[ -n "${remote_temporary}" && "${remote_temporary}" =~ ^/tmp/leviathan-bootstrap\.[A-Za-z0-9]+$ && -n "${ssh_target}" ]]; then
    # The client-side path is constrained by the exact mktemp prefix above.
    # shellcheck disable=SC2029
    ssh "${ssh_options[@]}" "${ssh_target}" "rm -rf -- '${remote_temporary}'" >/dev/null 2>&1 || true
  fi
  [[ -z "${state_file}" ]] || rm -f -- "${state_file}"
  [[ -z "${metadata_file}" ]] || rm -f -- "${metadata_file}"

  exit "${exit_status}"
}
trap cleanup EXIT

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 2
fi

case "$1" in
  list | install)
    action=$1
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    fail "first argument must be list or install"
    ;;
esac

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-url)
      [[ $# -ge 2 ]] || fail "--state-url requires a value"
      state_url=$2
      shift 2
      ;;
    --state-url=*)
      state_url=${1#*=}
      shift
      ;;
    --uplink-url | --uplink-hub-url)
	  [[ $# -ge 2 ]] || fail "$1 requires a value"
	  uplink_url=$2
	  shift 2
	  ;;
    --uplink-url=* | --uplink-hub-url=*)
	  uplink_url=${1#*=}
      shift
      ;;
    --instance-uuid)
      [[ $# -ge 2 ]] || fail "--instance-uuid requires a value"
      instance_uuid=$2
      shift 2
      ;;
    --instance-uuid=*)
      instance_uuid=${1#*=}
      shift
      ;;
    --creator-username)
      [[ $# -ge 2 ]] || fail "--creator-username requires a value"
      creator_username=$2
      shift 2
      ;;
    --creator-username=*)
      creator_username=${1#*=}
      shift
      ;;
    --host)
      [[ $# -ge 2 ]] || fail "--host requires a value"
      ssh_host=$2
      shift 2
      ;;
    --host=*)
      ssh_host=${1#*=}
      shift
      ;;
    --ssh-user)
      [[ $# -ge 2 ]] || fail "--ssh-user requires a value"
      ssh_user=$2
      shift 2
      ;;
    --ssh-user=*)
      ssh_user=${1#*=}
      shift
      ;;
    --identity-file)
      [[ $# -ge 2 ]] || fail "--identity-file requires a value"
      identity_file=$2
      shift 2
      ;;
    --identity-file=*)
      identity_file=${1#*=}
      shift
      ;;
    --binary)
      [[ $# -ge 2 ]] || fail "--binary requires a value"
      binary_path=$2
      shift 2
      ;;
    --binary=*)
      binary_path=${1#*=}
      shift
      ;;
    --binary-sha256)
      [[ $# -ge 2 ]] || fail "--binary-sha256 requires a value"
      binary_sha256=$2
      shift 2
      ;;
    --binary-sha256=*)
      binary_sha256=${1#*=}
      shift
      ;;
    --binary-arch)
      [[ $# -ge 2 ]] || fail "--binary-arch requires a value"
      binary_architecture=$2
      shift 2
      ;;
    --binary-arch=*)
      binary_architecture=${1#*=}
      shift
      ;;
    --token-keychain-service)
      [[ $# -ge 2 ]] || fail "--token-keychain-service requires a value"
      token_keychain_service=$2
      shift 2
      ;;
    --token-keychain-service=*)
      token_keychain_service=${1#*=}
      shift
      ;;
    --token-stdin)
      token_from_stdin=true
      shift
      ;;
    --verify-timeout)
      [[ $# -ge 2 ]] || fail "--verify-timeout requires a value"
      verify_timeout=$2
      shift 2
      ;;
    --verify-timeout=*)
      verify_timeout=${1#*=}
      shift
      ;;
    --apply)
      apply_changes=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

validate_state_url() {
  if [[ "${state_url}" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?/api/fleet/v1/state$ ]]; then
    return
  fi
  [[ "${state_url}" =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?/api/fleet/v1/state$ ]] ||
    fail "--state-url must be credential-free HTTPS or loopback HTTP with the exact fleet state path"
}

fetch_state() {
  curl --proto '=http,https' --connect-timeout 3 --max-time 15 \
    --fail --silent --show-error --output "${state_file}" "${state_url}"
  jq -e '.schemaVersion == "fleet-v1" and (.platforms | type == "array")' \
    "${state_file}" >/dev/null || fail "fleet state uses an incompatible schema"

  local platform_count
  platform_count=$(jq '[.platforms[] | select((((.platform.id // "") | ascii_downcase) == "jetstream") or .platform.kind == "openstack")] | length' "${state_file}")
  [[ "${platform_count}" == 1 ]] || fail "fleet state must contain exactly one Jetstream/OpenStack platform"

  local inventory_status
  inventory_status=$(jq -r '.platforms[] | select((((.platform.id // "") | ascii_downcase) == "jetstream") or .platform.kind == "openstack") | .inventory.status // "missing"' "${state_file}")
  [[ "${inventory_status}" == available ]] || fail "Jetstream inventory is ${inventory_status}; refusing to select a target"
}

validate_state_url
require_command curl
require_command jq
require_command mktemp
state_file=$(mktemp "${TMPDIR:-/tmp}/leviathan-bootstrap-state.XXXXXX")
fetch_state

if [[ "${action}" == list ]]; then
  [[ "${apply_changes}" == false ]] || fail "--apply is valid only with install"
  candidates=$(jq -c '
    .platforms[]
    | select((((.platform.id // "") | ascii_downcase) == "jetstream") or .platform.kind == "openstack")
    | .instances[]
    | select(
        .instance.cloudState == "active"
        and .managed == true
        and .agentProbeEligible == true
        and (.agent.source // "") != "leviathan_agent"
        and ((.agent.source // "") != "leviathan_uplink" or .agent.status != "available")
      )
    | {
        uuid: .instance.uuid,
        name: .instance.name,
        creatorUsername: .instance.creatorUsername,
        agentStatus: .agent.status,
        agentSource: (.agent.source // null)
      }
  ' "${state_file}")
  if [[ -z "${candidates}" ]]; then
    printf 'No active, authorized Jetstream instances need Uplink bootstrap.\n'
  else
    printf '%s\n' "${candidates}"
  fi
  exit 0
fi

[[ "${instance_uuid}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
  fail "--instance-uuid must be a canonical lowercase UUID"
[[ -n "${creator_username}" && ! "${creator_username}" =~ [[:space:][:cntrl:]] ]] ||
  fail "--creator-username must be a non-empty single-line value"
[[ "${ssh_host}" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] ||
  fail "--host must be an explicit DNS name or IPv4 address without a user prefix"
[[ "${ssh_user}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail "--ssh-user is invalid"
[[ -z "${identity_file}" || -f "${identity_file}" ]] || fail "identity file not found: ${identity_file}"
[[ -n "${binary_path}" && -f "${binary_path}" && -x "${binary_path}" ]] || fail "--binary must name an executable file"
binary_sha256=$(printf '%s' "${binary_sha256}" | tr '[:upper:]' '[:lower:]')
[[ "${binary_sha256}" =~ ^[0-9a-f]{64}$ ]] || fail "--binary-sha256 must contain exactly 64 hexadecimal characters"
case "${binary_architecture}" in
  amd64 | arm64) ;;
  *) fail "--binary-arch must be amd64 or arm64" ;;
esac
if [[ "${token_from_stdin}" == true ]]; then
  [[ -z "${token_keychain_service}" ]] || fail "choose only one token source"
else
  [[ "${token_keychain_service}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$ ]] ||
    fail "provide a valid --token-keychain-service or use --token-stdin"
fi
[[ "${uplink_url}" =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$ ]] ||
  fail "--uplink-url must be a credential-free HTTPS origin without a path"
[[ "${verify_timeout}" =~ ^[0-9]+$ ]] || fail "--verify-timeout must be an integer"
((verify_timeout >= 15 && verify_timeout <= 600)) || fail "--verify-timeout must be between 15 and 600 seconds"
[[ -f "${service_template}" ]] || fail "systemd template not found: ${service_template}"

validate_uplink_token() {
  if ((${#uplink_token} < 32 || ${#uplink_token} > 512)) ||
    [[ ! "${uplink_token}" =~ ^[A-Za-z0-9._~+/=-]+$ ]]; then
    unset uplink_token
    fail "creator token has an invalid length or character set"
  fi
}

# Read a piped token before SSH preflight because OpenSSH may otherwise consume
# the script's stdin. It remains an unexported shell variable and is never
# included in a process argument.
if [[ "${apply_changes}" == true && "${token_from_stdin}" == true ]]; then
  IFS= read -r uplink_token || fail "could not read creator token from stdin"
  validate_uplink_token
fi

target_count=$(jq --arg uuid "${instance_uuid}" '[
  .platforms[]
  | select((((.platform.id // "") | ascii_downcase) == "jetstream") or .platform.kind == "openstack")
  | .instances[]
  | select(.instance.uuid == $uuid)
] | length' "${state_file}")
[[ "${target_count}" == 1 ]] || fail "instance UUID is not uniquely present in current Jetstream inventory"

target_summary=$(jq -c --arg uuid "${instance_uuid}" '
  .platforms[]
  | select((((.platform.id // "") | ascii_downcase) == "jetstream") or .platform.kind == "openstack")
  | .instances[]
  | select(.instance.uuid == $uuid)
  | {
      name: .instance.name,
      creatorUsername: .instance.creatorUsername,
      cloudState: .instance.cloudState,
      managed: .managed,
      eligible: .agentProbeEligible,
      agentStatus: .agent.status,
      agentSource: (.agent.source // "")
    }
' "${state_file}")

target_creator=$(jq -r '.creatorUsername // ""' <<<"${target_summary}")
target_cloud_state=$(jq -r '.cloudState // ""' <<<"${target_summary}")
target_managed=$(jq -r '.managed // false' <<<"${target_summary}")
target_eligible=$(jq -r '.eligible // false' <<<"${target_summary}")
target_agent_status=$(jq -r '.agentStatus // ""' <<<"${target_summary}")
target_agent_source=$(jq -r '.agentSource // ""' <<<"${target_summary}")
target_name=$(jq -r '.name // ""' <<<"${target_summary}")

[[ "${target_creator}" == "${creator_username}" ]] ||
  fail "creator mismatch between the selected Yggdrasil instance and --creator-username"
[[ "${target_cloud_state}" == active ]] || fail "instance is ${target_cloud_state}, not active"
[[ "${target_managed}" == true ]] || fail "instance is inventory-only and not authorized for monitoring"
[[ "${target_eligible}" == true ]] || fail "instance is not eligible for an agent connection"
if [[ "${target_agent_source}" == leviathan_agent ]]; then
  fail "instance has an exact Leviathan pull binding; migrate that Yggdrasil binding before installing Uplink"
fi
if [[ "${target_agent_source}" == leviathan_uplink && "${target_agent_status}" == available ]]; then
  printf 'Instance %s (%s) already has a live Leviathan Uplink; no changes made.\n' "${target_name}" "${instance_uuid}"
  exit 0
fi

require_command file
require_command ssh
require_command wc
if command -v shasum >/dev/null 2>&1; then
  actual_binary_sha256=$(shasum -a 256 "${binary_path}" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  actual_binary_sha256=$(sha256sum "${binary_path}" | awk '{print $1}')
else
  fail "shasum or sha256sum is required"
fi
[[ "${actual_binary_sha256}" == "${binary_sha256}" ]] || fail "local binary SHA-256 does not match --binary-sha256"

binary_description=$(file -b "${binary_path}")
[[ "${binary_description}" == *ELF* ]] || fail "--binary is not a Linux ELF executable"
case "${binary_architecture}" in
  amd64) [[ "${binary_description}" == *x86-64* || "${binary_description}" == *x86_64* ]] || fail "binary is not amd64" ;;
  arm64) [[ "${binary_description}" == *aarch64* || "${binary_description}" == *ARM64* ]] || fail "binary is not arm64" ;;
esac

if [[ -n "${identity_file}" ]]; then
  ssh_options+=(-i "${identity_file}" -o IdentitiesOnly=yes)
fi
ssh_target="${ssh_user}@${ssh_host}"

remote_info=$(ssh "${ssh_options[@]}" "${ssh_target}" '
  set -eu
  command -v curl >/dev/null
  command -v head >/dev/null
  command -v sha256sum >/dev/null
  command -v sudo >/dev/null
  command -v systemctl >/dev/null
  sudo -n true
  printf "%s\n%s\n%s\n" "$(uname -s)" "$(uname -m)" "$(id -un)"
')
remote_info_lines=$(printf '%s\n' "${remote_info}" | wc -l | tr -d '[:space:]')
[[ "${remote_info_lines}" == 3 ]] || fail "SSH preflight returned unexpected output; check the exact host and SSH configuration"
remote_operating_system=$(printf '%s\n' "${remote_info}" | sed -n '1p')
remote_machine=$(printf '%s\n' "${remote_info}" | sed -n '2p')
remote_user=$(printf '%s\n' "${remote_info}" | sed -n '3p')
[[ "${remote_operating_system}" == Linux ]] || fail "SSH target is not Linux"
[[ "${remote_user}" == "${ssh_user}" ]] || fail "SSH target logged in as ${remote_user}, not ${ssh_user}"
case "${remote_machine}" in
  x86_64 | amd64) remote_architecture=amd64 ;;
  aarch64 | arm64) remote_architecture=arm64 ;;
  *) fail "unsupported SSH target architecture: ${remote_machine}" ;;
esac
[[ "${remote_architecture}" == "${binary_architecture}" ]] ||
  fail "binary architecture ${binary_architecture} does not match SSH target ${remote_architecture}"

metadata_file=$(mktemp "${TMPDIR:-/tmp}/leviathan-bootstrap-metadata.XXXXXX")
ssh "${ssh_options[@]}" "${ssh_target}" \
  "curl --noproxy '*' --proto '=http' --connect-timeout 2 --max-time 5 --fail --silent --show-error http://169.254.169.254/openstack/latest/meta_data.json | head -c 65537" \
  >"${metadata_file}"
metadata_size=$(wc -c <"${metadata_file}" | tr -d '[:space:]')
((metadata_size > 0 && metadata_size <= 65536)) || fail "SSH target metadata response is empty or too large"
remote_instance_uuid=$(jq -er '.uuid | select(type == "string")' "${metadata_file}") || fail "SSH target metadata has no UUID"
[[ "${remote_instance_uuid}" == "${instance_uuid}" ]] ||
  fail "SSH target metadata UUID ${remote_instance_uuid} does not match selected instance ${instance_uuid}"

printf 'Validated Jetstream Uplink bootstrap plan:\n'
printf '  instance: %s (%s)\n' "${target_name}" "${instance_uuid}"
printf '  creator:  %s\n' "${creator_username}"
printf '  SSH:      %s (metadata UUID matched)\n' "${ssh_target}"
printf '  binary:   %s (%s, %s)\n' "${binary_path}" "${binary_architecture}" "${binary_sha256}"
printf '  uplink:   %s\n' "${uplink_url}"

if [[ "${apply_changes}" == false ]]; then
  printf 'Dry run complete; no Leviathan files or services were changed. Re-run with --apply to install.\n'
  exit 0
fi

# Authentication or an SSH passphrase prompt may make preflight take time. Gate
# the mutating phase on a second, fresh Yggdrasil snapshot rather than the snapshot
# used to produce the plan above.
fetch_state
apply_target_count=$(jq --arg uuid "${instance_uuid}" '[
  .platforms[]
  | select((((.platform.id // "") | ascii_downcase) == "jetstream") or .platform.kind == "openstack")
  | .instances[]
  | select(.instance.uuid == $uuid)
] | length' "${state_file}")
[[ "${apply_target_count}" == 1 ]] || fail "selected instance changed before apply; run the dry run again"
apply_target_gate=$(jq -r --arg uuid "${instance_uuid}" '
  .platforms[]
  | select((((.platform.id // "") | ascii_downcase) == "jetstream") or .platform.kind == "openstack")
  | .instances[]
  | select(.instance.uuid == $uuid)
  | [
      .instance.creatorUsername,
      .instance.cloudState,
      (.managed | tostring),
      (.agentProbeEligible | tostring),
      .agent.status,
      (.agent.source // "")
    ]
  | @tsv
' "${state_file}")
IFS=$'\t' read -r apply_creator apply_cloud apply_managed apply_eligible apply_status apply_source <<<"${apply_target_gate}"
[[ "${apply_creator}" == "${creator_username}" && "${apply_cloud}" == active && "${apply_managed}" == true && "${apply_eligible}" == true ]] ||
  fail "selected instance ownership, state, or monitoring policy changed before apply"
[[ "${apply_source}" != leviathan_agent ]] || fail "an exact Leviathan pull binding appeared before apply"
if [[ "${apply_source}" == leviathan_uplink && "${apply_status}" == available ]]; then
  printf 'Instance %s (%s) became live through Leviathan Uplink; no changes made.\n' "${target_name}" "${instance_uuid}"
  exit 0
fi

require_command scp
if [[ "${token_from_stdin}" == false ]]; then
  require_command security
fi

remote_temporary=$(ssh "${ssh_options[@]}" "${ssh_target}" 'mktemp -d /tmp/leviathan-bootstrap.XXXXXX')
[[ "${remote_temporary}" =~ ^/tmp/leviathan-bootstrap\.[A-Za-z0-9]+$ ]] ||
  fail "remote mktemp returned an unsafe path"

scp "${ssh_options[@]}" "${binary_path}" "${ssh_target}:${remote_temporary}/leviathan"
scp "${ssh_options[@]}" "${service_template}" "${ssh_target}:${remote_temporary}/leviathan-uplink@.service"
# The client-side path is constrained by the exact mktemp prefix above.
# shellcheck disable=SC2029
remote_checksum_line=$(ssh "${ssh_options[@]}" "${ssh_target}" "sha256sum '${remote_temporary}/leviathan'")
remote_binary_sha256=$(awk '{print $1}' <<<"${remote_checksum_line}")
[[ "${remote_binary_sha256}" == "${binary_sha256}" ]] || fail "binary SHA-256 changed during SSH transfer"

# Both client-side paths are constrained by exact checks before this command.
# shellcheck disable=SC2029
ssh "${ssh_options[@]}" "${ssh_target}" "
  set -eu
  sudo install -o root -g root -m 0755 '${remote_temporary}/leviathan' /usr/local/bin/leviathan
  sudo install -o root -g root -m 0644 '${remote_temporary}/leviathan-uplink@.service' /etc/systemd/system/leviathan-uplink@.service
"

if [[ "${token_from_stdin}" == false ]]; then
  uplink_token=$(security find-generic-password -w -s "${token_keychain_service}" 2>/dev/null) ||
    fail "could not read creator token from Keychain service ${token_keychain_service}"
  validate_uplink_token
fi
# The client-side environment path contains only the validated Linux username.
# shellcheck disable=SC2029
{
  printf 'YGGDRASIL_UPLINK_URL=%s\n' "${uplink_url}"
  printf 'LEVIATHAN_UPLINK_TOKEN=%s\n' "${uplink_token}"
} | ssh "${ssh_options[@]}" "${ssh_target}" \
  "sudo install -D -o root -g root -m 0600 /dev/stdin '/etc/leviathan/uplink-${ssh_user}.env'"
unset uplink_token

unit_name="leviathan-uplink@${ssh_user}.service"
# The client-side unit name contains only the validated Linux username.
# shellcheck disable=SC2029
ssh "${ssh_options[@]}" "${ssh_target}" "
  set -eu
  sudo systemctl daemon-reload
  sudo systemctl enable '${unit_name}' >/dev/null
  sudo systemctl restart '${unit_name}'
  sudo systemctl is-enabled --quiet '${unit_name}'
  sudo systemctl is-active --quiet '${unit_name}'
"

deadline=$(($(date +%s) + verify_timeout))
while true; do
  fetch_state
  acknowledgement=$(jq -r --arg uuid "${instance_uuid}" '
    .platforms[]
    | select((((.platform.id // "") | ascii_downcase) == "jetstream") or .platform.kind == "openstack")
    | .instances[]
    | select(.instance.uuid == $uuid)
    | [
        .instance.creatorUsername,
        .instance.cloudState,
        (.managed | tostring),
        (.agentProbeEligible | tostring),
        .agent.status,
        (.agent.source // "")
      ]
    | @tsv
  ' "${state_file}")
  IFS=$'\t' read -r current_creator current_cloud current_managed current_eligible current_status current_source <<<"${acknowledgement}"
  [[ "${current_creator}" == "${creator_username}" ]] || fail "creator changed while waiting for Yggdrasil acknowledgement"
  [[ "${current_cloud}" == active && "${current_managed}" == true && "${current_eligible}" == true ]] ||
    fail "instance eligibility changed while waiting for Yggdrasil acknowledgement"
  if [[ "${current_status}" == available && "${current_source}" == leviathan_uplink ]]; then
    printf 'Leviathan Uplink is active and acknowledged by Yggdrasil for %s (%s).\n' "${target_name}" "${instance_uuid}"
    exit 0
  fi
  if (( $(date +%s) >= deadline )); then
    fail "systemd is active but Yggdrasil did not acknowledge Uplink within ${verify_timeout} seconds"
  fi
  sleep 5
done
