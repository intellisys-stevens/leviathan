# Release procedure

Leviathan publishes stable releases only. Release workflows reject suffixes
such as release candidates and run only for final `v<major>.<minor>.<patch>`
tags.

For the one-time v0.3.0 repository rename:

1. Keep the old repository's `main` branch at v0.2.1. Finish the rename on a
   branch, run the complete local/non-publishing dry run, freeze writes, and
   recheck the exact repository, default branch, protection, package, and
   environment targets. Do not create or move a tag.
2. Rename the GitHub repository from `miglens` to `leviathan` before pushing or
   merging the rename. Keep the v0.2.1 tag and release untouched. GitHub
   redirects repository and Git URLs, but GHCR package names are independent;
   the old image/chart names remain only for rollback.
3. Change local remotes to
   `https://github.com/intellisys-stevens/leviathan.git`, audit branch
   protection, Actions environments, package access, and OIDC subjects. Push
   the rename branch, require CI's full non-publishing release dry run, then
   merge it into `main` under the new repository identity:

   ```bash
   git remote set-url origin https://github.com/intellisys-stevens/leviathan.git
   git remote -v
   ```

4. Manually run CI on the resulting `main` commit and require that exact SHA and
   every dry-run job to pass. Then create an annotated `v0.3.0` tag on that
   commit and push only that tag. The tag-only workflow builds, signs, attests,
   and publishes archives, SBOMs, the bridge image, and the Helm chart.

   ```bash
   git tag -a v0.3.0 -m "Leviathan v0.3.0"
   git push origin v0.3.0
   ```
5. Verify the GitHub release checksums and attestations, both native archives,
   `ghcr.io/intellisys-stevens/leviathan-kubernetes-bridge:0.3.0`, and
   `oci://ghcr.io/intellisys-stevens/charts/leviathan-attribution:0.3.0` before
   treating the release as deployable.

Never reuse a tag. A failed publish is fixed on a new version after deleting
only incomplete v0.3.0 artifacts; the signed v0.2.1 rollback release remains
available.

## v0.3.1 patch release

Prepare the `0.3.1` OpenAPI, dashboard, lockfile, Helm chart, documentation,
and release-verifier metadata together on a pull request. Require the complete
CI and non-publishing release dry run on the merged `main` commit before
creating the release tag.

After that exact commit is green, create and push a new annotated tag; never
move or reuse `v0.3.0`:

```bash
git tag -a v0.3.1 -m "Leviathan v0.3.1"
git push origin v0.3.1
```

The tag workflow must finish successfully before v0.3.1 is treated as
published. Verify both native archives, checksums, attestations, SBOMs, the
`leviathan-kubernetes-bridge:0.3.1` image, and the
`leviathan-attribution:0.3.1` OCI chart.

## v0.3.2 patch release

Prepare the `0.3.2` OpenAPI information version, dashboard and lockfile, Helm
chart, Kubernetes example, CI dry-run fixtures, and release-verifier metadata
together on a pull request. Require the complete CI and non-publishing release
dry run on the squash-merged `main` commit before creating any release tag.

After that exact commit is green, a release operator may create and push a new
annotated tag. Never move or reuse the published `v0.3.1` tag:

```bash
git tag -a v0.3.2 -m "Leviathan v0.3.2"
git push origin v0.3.2
```

The tag workflow must finish successfully before v0.3.2 is treated as
published. Verify both native archives, checksums, attestations, SBOMs, the
`leviathan-kubernetes-bridge:0.3.2` image, and the
`leviathan-attribution:0.3.2` OCI chart. Preparing or merging the release PR
does not itself authorize tagging, publishing, or deployment.

## v0.4.0 feature release

Prepare the `0.4.0` OpenAPI information version, dashboard and lockfile, Helm
chart, Kubernetes example, CI dry-run fixtures, changelog, systemd uplink
drop-in, and cross-repository `uplink-v1` golden payload together. Require the
complete CI and non-publishing release dry run on the squash-merged `main`
commit before creating any release tag.

Before tagging, verify on Linux that a GPU-less host publishes system telemetry,
default doctor succeeds with a warning, `doctor --require-gpu` fails, and a GPU
failure leaves system publication and the in-process uplink operational. Verify
the Yggdrasil staging ingress accepts the exact shared golden contract, duplicate
receipts remain idempotent, token rotation overlaps safely, and no excluded host
or process data crosses the boundary.

After that exact commit is green, create and push a new annotated tag. Never
move or reuse the published `v0.3.2` tag:

```bash
git tag -a v0.4.0 -m "Leviathan v0.4.0"
git push origin v0.4.0
```

The tag workflow must finish successfully before v0.4.0 is treated as
published. Verify both native archives, checksums, attestations, SBOMs, the
`leviathan-kubernetes-bridge:0.4.0` image, and the
`leviathan-attribution:0.4.0` OCI chart. Preserve the v0.3.2 binaries,
configuration, and backups until host telemetry and Yggdrasil receipts have
been observed in the deployment.

## Managed update signing

Every new GitHub release must include
`leviathan_linux_amd64.manifest.json` and
`leviathan_linux_arm64.manifest.json`. Each Ed25519-signed envelope binds the
stable version, full source commit, operating system, architecture, glibc
baseline, updater/configuration/state compatibility, archive digest and size,
and the exact Leviathan executable digest and size. Release binaries now record
the full source commit. The updater executable, opt-in bootstrap and independent
offline recovery unit are packaged in each native archive.

Before publishing, a repository administrator must configure the
`managed-release-signing` GitHub environment with required reviewers and
deployment restrictions allowing only reviewed stable release tags. Put the
approved Ed25519 key in that environment's `LEVIATHAN_UPDATE_SIGNING_KEY` secret
as standard base64 of its 32-byte seed or 64-byte private key. Set the environment
variable `LEVIATHAN_UPDATE_SIGNING_KEY_ID` to the first 32 lowercase hex
characters of SHA-256 of the raw 32-byte public key. Supply and manage the
production key through the organization's approved key process; this repository
does not generate one.

The signer is built before the key is exposed. The signing step writes the key
only to a mode-0600 file under its runner-local `CODEX_SECRETS_DIR`, removes it
on exit, and checks it against the separately configured public key ID. Missing
or mismatched key configuration fails the release instead of publishing an
unsigned managed update. No private signing key belongs in an archive, catalog,
host configuration, source checkout or test fixture. The test keys are disposable
and never production credentials.

The protected signing job attests both manifests with GitHub provenance. The
publish job depends on it, requires both manifest files and includes their
SHA-256 entries in `checksums.txt`. Existing provenance/SBOM gates still apply
to both native archives and the other release artifacts. Configuring these
workflow files alone does not establish that the GitHub environment protections
or production signing key have been provisioned.

To independently verify either an archive or manifest, select the exact stable
tag and reviewed full source commit, then use the GitHub CLI's
[attestation verification policy flags](https://cli.github.com/manual/gh_attestation_verify):

```bash
gh attestation verify "$ARTIFACT" \
  --hostname github.com \
  --repo intellisys-stevens/leviathan \
  --signer-workflow github.com/intellisys-stevens/leviathan/.github/workflows/release.yml \
  --source-ref "refs/tags/$REVIEWED_TAG" \
  --source-digest "$REVIEWED_COMMIT" --signer-digest "$REVIEWED_COMMIT" \
  --cert-identity "https://github.com/intellisys-stevens/leviathan/.github/workflows/release.yml@refs/tags/$REVIEWED_TAG" \
  --predicate-type https://slsa.dev/provenance/v1 \
  --deny-self-hosted-runners
```

Verify that GitHub marks that tag's release as neither draft nor prerelease.
Yggdrasil's catalog importer automates these checks for both artifacts before
mirroring, then verifies the Ed25519 signature against an independently pinned
PKIX public key and checks the archive and binary digests without extracting
untrusted paths. Hosts fetch the resulting archive through Yggdrasil's origin.
See [managed host bootstrap](managed-updates.md) for the separate, explicit
installation step. Nothing in the build or release workflow deploys it to a host.
