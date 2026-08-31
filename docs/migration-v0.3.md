# Migrating from v0.2.1

Leviathan v0.3.0 is a clean product rename. It does not install aliases, accept
legacy environment variables or configuration, reuse the old Unix socket, or
ship the old service and package names. A legacy environment variable causes a
startup error that names its `LEVIATHAN_*` replacement; it is never used as a
fallback.

| v0.2.1 | v0.3.0 |
| --- | --- |
| `miglens` | `leviathan` |
| `MIGLENS_*` | `LEVIATHAN_*` |
| `$XDG_CONFIG_HOME/miglens/config.toml` | `$XDG_CONFIG_HOME/leviathan/config.toml` |
| `miglens@.service` and `/etc/miglens/miglens.env` | `leviathan@.service` and `/etc/leviathan/leviathan.env` |
| `/run/miglens/attribution.sock` | `/run/leviathan/attribution.sock` |
| `miglens-kubernetes-bridge` | `leviathan-kubernetes-bridge` |
| `miglens-attribution` in `miglens-system` | `leviathan-attribution` in `leviathan-system` |
| `miglens_linux_<arch>.tar.gz` | `leviathan_linux_<arch>.tar.gz` |

Install Leviathan and its bridge side by side under the new names and copy
desired values into the new configuration. During the cutover, stop v0.2.1,
start and verify Leviathan, and retain the old binary and units until acceptance
checks pass. The HTTP API remains at `/api/v1`; existing API clients do not need
a route change.

## Installer limitation

A saved v0.2.1 `install.sh` invoked with its default `latest` setting stops
working once v0.3.0 becomes latest: that script requests a
`miglens_linux_<arch>.tar.gz` asset, while v0.3.0 intentionally publishes only
`leviathan_linux_<arch>.tar.gz`. It does not silently install Leviathan. Use the
v0.3.0 installer for Leviathan, or pin the historical v0.2.1 assets when rolling
back.

## Exact v0.2.1 rollback

The repository rename preserves the historical `v0.2.1` tag and release. The
old GHCR bridge and chart package names also remain historical artifacts; they
are not republished under the new names.

```bash
set -euo pipefail

case "$(uname -m)" in
  x86_64|amd64) release_arch=amd64 ;;
  aarch64|arm64) release_arch=arm64 ;;
  *) echo "unsupported architecture" >&2; exit 1 ;;
esac

release_url=https://github.com/intellisys-stevens/leviathan/releases/download/v0.2.1
curl -fL -o "miglens_linux_${release_arch}.tar.gz" \
  "${release_url}/miglens_linux_${release_arch}.tar.gz"
curl -fL -o checksums.txt "${release_url}/checksums.txt"
grep "  miglens_linux_${release_arch}.tar.gz$" checksums.txt | sha256sum -c -
tar -xzf "miglens_linux_${release_arch}.tar.gz"
release_dir="miglens_0.2.1_linux_${release_arch}"

# Restore and verify the v0.2.1 bridge before starting the v0.2.1 host client;
# the old client must never be connected to the Leviathan bridge schema.
helm upgrade --install miglens-attribution \
  oci://ghcr.io/intellisys-stevens/charts/miglens-attribution \
  --version 0.2.1 \
  --namespace miglens-system \
  --create-namespace \
  --wait --timeout 5m \
  --set-json 'workspaceNamespaces=["coder-docker-workspaces","coder-workspaces"]'
helm status miglens-attribution --namespace miglens-system
sudo curl --fail --silent --show-error \
  --unix-socket /run/miglens/attribution.sock http://localhost/readyz

sudo install -m 0755 "${release_dir}/miglens" /usr/local/bin/miglens
sudo install -m 0644 "${release_dir}/miglens@.service" \
  /etc/systemd/system/miglens@.service
sudo install -D -m 0644 "${release_dir}/miglens-attribution.env" \
  /etc/miglens/miglens.env
sudo install -D -m 0644 \
  "${release_dir}/miglens@root.service.d/10-hardening.conf" \
  /etc/systemd/system/miglens@root.service.d/10-hardening.conf
sudo systemctl daemon-reload
sudo systemctl disable --now leviathan@root.service
sudo systemctl enable --now miglens@root.service
curl -fsS http://127.0.0.1:1397/healthz
curl -fsS http://127.0.0.1:1397/api/v1/snapshot

# Remove the new bridge only after both v0.2.1 checks succeed.
helm uninstall leviathan-attribution --namespace leviathan-system --ignore-not-found
```

Remove the Leviathan binary, service files, chart, and configuration only after
the v0.2.1 health and attribution checks pass.
