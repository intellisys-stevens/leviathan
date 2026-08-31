#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
bootstrap="${repository_root}/scripts/bootstrap-jetstream-uplink.sh"
test_root=$(mktemp -d)

cleanup() {
  rm -rf -- "${test_root}"
}
trap cleanup EXIT

fail() {
  printf 'Jetstream bootstrap test: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file=$1
  local expected=$2
  grep -F -- "${expected}" "${file}" >/dev/null || fail "${file} does not contain: ${expected}"
}

assert_not_contains() {
  local file=$1
  local unexpected=$2
  if grep -F -- "${unexpected}" "${file}" >/dev/null; then
    fail "${file} unexpectedly contains: ${unexpected}"
  fi
}

assert_failed() {
  local output=$1
  shift
  if "$@" >"${output}" 2>&1; then
    fail "command unexpectedly succeeded: $*"
  fi
}

instance_uuid=11111111-1111-4111-8111-111111111111
creator_username=owner-a@example.test
fake_token=TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT
state_initial="${test_root}/state-initial.json"
state_uplink="${test_root}/state-uplink.json"
fake_bin="${test_root}/fake-bin"
fake_log="${test_root}/fake.log"
curl_counter="${test_root}/curl-counter"
binary="${test_root}/leviathan"
mkdir -p "${fake_bin}"

cat >"${state_initial}" <<EOF
{
  "schemaVersion": "fleet-v1",
  "sequence": 1,
  "platforms": [
    {
      "platform": {"id": "jetstream", "kind": "openstack"},
      "inventory": {"status": "available"},
      "instances": [
        {
          "instance": {
            "uuid": "${instance_uuid}",
            "name": "fixture-gpu",
            "creatorUsername": "${creator_username}",
            "cloudState": "active"
          },
          "managed": true,
          "agentProbeEligible": true,
          "agent": {"status": "not_configured"}
        }
      ]
    }
  ]
}
EOF

cat >"${state_uplink}" <<EOF
{
  "schemaVersion": "fleet-v1",
  "sequence": 2,
  "platforms": [
    {
      "platform": {"id": "jetstream", "kind": "openstack"},
      "inventory": {"status": "available"},
      "instances": [
        {
          "instance": {
            "uuid": "${instance_uuid}",
            "name": "fixture-gpu",
            "creatorUsername": "${creator_username}",
            "cloudState": "active"
          },
          "managed": true,
          "agentProbeEligible": true,
          "agent": {"status": "available", "source": "leviathan_uplink"}
        }
      ]
    }
  ]
}
EOF

cat >"${fake_bin}/curl" <<'EOF'
#!/bin/sh
set -eu
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      shift
      output=${1:?missing curl output}
      ;;
  esac
  shift
done
[ -n "${output}" ]
count=0
if [ -f "${FAKE_CURL_COUNTER:?}" ]; then
  count=$(cat "${FAKE_CURL_COUNTER}")
fi
count=$((count + 1))
printf '%s\n' "${count}" >"${FAKE_CURL_COUNTER}"
switch_after=${FAKE_CURL_SWITCH_AFTER:-1}
if [ "${count}" -gt "${switch_after}" ] && [ -n "${FAKE_CURL_AFTER_FIRST:-}" ]; then
  cp "${FAKE_CURL_AFTER_FIRST}" "${output}"
else
  cp "${FAKE_CURL_STATE:?}" "${output}"
fi
EOF

cat >"${fake_bin}/file" <<'EOF'
#!/bin/sh
printf '%s\n' 'ELF 64-bit LSB executable, x86-64, dynamically linked, stripped'
EOF

cat >"${fake_bin}/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
command_text=${!#}
printf 'SSH %s\n' "${command_text}" >>"${FAKE_COMMAND_LOG:?}"
case "${command_text}" in
  *'printf "%s\n%s\n%s\n"'*)
    printf 'Linux\nx86_64\nexouser\n'
    ;;
  *meta_data.json*)
    printf '{"uuid":"%s"}\n' "${FAKE_REMOTE_UUID:?}"
    ;;
  *'mktemp -d /tmp/leviathan-bootstrap.XXXXXX'*)
    printf '/tmp/leviathan-bootstrap.ABC123\n'
    ;;
  *sha256sum*)
    printf '%s\n' "${FAKE_BINARY_SHA256:?}"
    ;;
  *'/dev/stdin'*)
    cat >/dev/null
    ;;
esac
EOF

cat >"${fake_bin}/scp" <<'EOF'
#!/bin/sh
printf 'SCP %s\n' "$*" >>"${FAKE_COMMAND_LOG:?}"
EOF

cat >"${fake_bin}/security" <<'EOF'
#!/bin/sh
printf 'SECURITY_READ\n' >>"${FAKE_COMMAND_LOG:?}"
printf '%s\n' "${FAKE_TOKEN:?}"
EOF

chmod 0755 "${fake_bin}"/*
printf '#!/bin/sh\nexit 0\n' >"${binary}"
chmod 0755 "${binary}"
binary_sha256=$(shasum -a 256 "${binary}" | awk '{print $1}')

common_environment=(
  PATH="${fake_bin}:/usr/bin:/bin"
  FAKE_CURL_STATE="${state_initial}"
  FAKE_CURL_COUNTER="${curl_counter}"
  FAKE_COMMAND_LOG="${fake_log}"
  FAKE_REMOTE_UUID="${instance_uuid}"
  FAKE_BINARY_SHA256="${binary_sha256}"
  FAKE_TOKEN="${fake_token}"
)
common_arguments=(
  install
  --instance-uuid "${instance_uuid}"
  --creator-username "${creator_username}"
  --host 192.0.2.10
  --ssh-user exouser
  --binary "${binary}"
  --binary-sha256 "${binary_sha256}"
  --binary-arch amd64
  --token-keychain-service org.example.leviathan.owner-a
  --uplink-url https://uplink.example.test:8443
)
stdin_arguments=(
  install
  --instance-uuid "${instance_uuid}"
  --creator-username "${creator_username}"
  --host 192.0.2.10
  --ssh-user exouser
  --binary "${binary}"
  --binary-sha256 "${binary_sha256}"
  --binary-arch amd64
  --token-stdin
  --uplink-url https://uplink.example.test:8443
)

# Candidate listing uses only current Yggdrasil policy and makes no SSH connection.
: >"${curl_counter}"
env "${common_environment[@]}" "${bootstrap}" list >"${test_root}/list-output"
assert_contains "${test_root}/list-output" "\"uuid\":\"${instance_uuid}\""
[[ ! -e "${fake_log}" ]] || fail "candidate listing attempted SSH"

# Default install mode performs complete read-only target and binary validation.
: >"${curl_counter}"
: >"${fake_log}"
env "${common_environment[@]}" "${bootstrap}" "${common_arguments[@]}" >"${test_root}/dry-run-output"
assert_contains "${test_root}/dry-run-output" 'metadata UUID matched'
assert_contains "${test_root}/dry-run-output" 'Dry run complete; no Leviathan files or services were changed.'
assert_not_contains "${fake_log}" 'mktemp -d /tmp/leviathan-bootstrap.XXXXXX'
assert_not_contains "${fake_log}" 'systemctl restart'

# A recycled or incorrectly mapped SSH IP fails before any remote mutation.
: >"${curl_counter}"
: >"${fake_log}"
assert_failed "${test_root}/metadata-mismatch-output" env \
  "${common_environment[@]}" FAKE_REMOTE_UUID=22222222-2222-4222-8222-222222222222 \
  "${bootstrap}" "${common_arguments[@]}"
assert_contains "${test_root}/metadata-mismatch-output" 'does not match selected instance'
assert_not_contains "${fake_log}" 'mktemp -d /tmp/leviathan-bootstrap.XXXXXX'

# --apply installs, starts systemd, and waits for an exact Yggdrasil acknowledgement.
: >"${curl_counter}"
: >"${fake_log}"
env "${common_environment[@]}" FAKE_CURL_AFTER_FIRST="${state_uplink}" \
  FAKE_CURL_SWITCH_AFTER=2 \
  "${bootstrap}" "${common_arguments[@]}" --apply >"${test_root}/apply-output"
assert_contains "${test_root}/apply-output" 'Leviathan Uplink is active and acknowledged by Yggdrasil'
assert_contains "${fake_log}" 'systemctl restart'
assert_contains "${fake_log}" '/etc/leviathan/uplink-exouser.env'
assert_not_contains "${fake_log}" "${fake_token}"
assert_not_contains "${test_root}/apply-output" "${fake_token}"

# A secret-manager pipe is accepted without invoking the generic Keychain CLI.
: >"${curl_counter}"
: >"${fake_log}"
printf '%s\n' "${fake_token}" | env "${common_environment[@]}" \
  FAKE_CURL_AFTER_FIRST="${state_uplink}" FAKE_CURL_SWITCH_AFTER=2 \
  "${bootstrap}" "${stdin_arguments[@]}" --apply >"${test_root}/stdin-apply-output"
assert_contains "${test_root}/stdin-apply-output" 'Leviathan Uplink is active and acknowledged by Yggdrasil'
assert_not_contains "${fake_log}" 'SECURITY_READ'
assert_not_contains "${fake_log}" "${fake_token}"
assert_not_contains "${test_root}/stdin-apply-output" "${fake_token}"

# A live Uplink is not a bootstrap candidate and is never reinstalled.
: >"${curl_counter}"
: >"${fake_log}"
env "${common_environment[@]}" FAKE_CURL_STATE="${state_uplink}" \
  "${bootstrap}" list >"${test_root}/live-list-output"
assert_contains "${test_root}/live-list-output" 'No active, authorized Jetstream instances need Uplink bootstrap.'
: >"${curl_counter}"
env "${common_environment[@]}" FAKE_CURL_STATE="${state_uplink}" \
  "${bootstrap}" "${common_arguments[@]}" >"${test_root}/live-install-output"
assert_contains "${test_root}/live-install-output" 'already has a live Leviathan Uplink; no changes made.'
[[ ! -s "${fake_log}" ]] || fail "live Uplink was contacted over SSH"

printf 'Jetstream bootstrap tests passed\n'
