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
