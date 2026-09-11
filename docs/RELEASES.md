# Controlled product releases

`ProductReleases` is a credential-broker adapter. Employees call its scoped tools; they never receive GitHub credentials or the prepared package spool. No release is published by merely implementing or testing this adapter.

```ts
const releases = new ProductReleases(store, workspaces, { effects: sharedNativeBuildControllers });
const candidate = await releases.prepare(actor, { artifactId, version, notes });
const published = await releases.publish(actor, { releaseId: candidate.id });
```

Both calls require a current, authorized employee run assigned to the source project. The source must be an independently reviewed commit with canonical verifier receipts and a completed reviewed merge. Preparation checks the live GitHub PR head, merge commit, default-branch ancestry, product identity and repository visibility. The merged Git tree must equal the reviewed tree. A merge that changes content requires independent review and verification of that changed source.

## WalkLang package preparation

Preparation creates a separate detached worktree at the immutable merged commit in the company workspace root. The existing product checkout and implementation workspace remain untouched. The native sandbox runs the existing release procedure with network denied and one shared native build slot:

1. Export the final `WALK_VERSION` for all verification and packaging commands.
2. Run `make clean`, `make -j4 walk test`, `make conformance`, compatibility stress tests and documentation checks.
3. Run `scripts/release.sh` at that same version.
4. Check the packaged `walk --version`, execute the packaged `walktop --once --fixture tools/walktop/testdata/basic`, and inspect the runtime archive.
5. Confirm tracked source is unchanged; check exactly the current-host compiler, current-host walktop, runtime archive and SHA256SUMS exist.
6. Verify actual SHA256 bytes against the generated checksums. Reject links, additional files, empty/oversized files, source drift and build failure.

The broker copies packages into `dataRoot/releases/<releaseId>/assets` as read-only files. `manifest.json` links the source artifact, merged commit, Git tree, host, final version, package digest, byte hashes, sizes and build command. `build.log` retains actual output. Every publish attempt revalidates this manifest and the package bytes. Failed or interrupted build evidence is retained; a fresh preparation attempt is bounded by the configured retry limit. Active or uncertain prior process ownership prevents another build.

Current-host packaging matches WalkLang's existing release script and recorded release procedure. Release notes state the observed host and source commit. This adapter does not claim cross-platform assets that the current host did not build.

## GitHub publication and recovery

Publication requires the existing matching product identity and an active public repository. Repository workflows are inspected for the qualified standard free runners/actions; unknown provider charging is rejected before publication. Private repository charging creates a concrete blocked spending request. Local compilation has no hosted inference or provider build fallback.

Each external effect has a distinct durable intent and observed provider result:

- create or confirm the exact immutable tag;
- create the matching draft release metadata;
- upload each package file separately;
- publish only when tag, release metadata and the exact complete asset set match the package.

The adapter never overwrites tags, foreign release notes or assets. Assets must have matching provider SHA256 digests and byte lengths. GitHub's legacy latest-release selection applies when a completed draft becomes public, respecting release version ordering.

Lifecycle, actor, policy revision, independent review and cost checks run immediately before every effect. A pause after a tag or asset request may allow that in-flight result to be observed, but prevents subsequent writes. Completed effects are reused without duplicate publication. An interrupted send is reconciled by the exact provider tag, durable release marker or asset digest; conclusive absence permits at most one retry. Unknown or conflicting observations remain blocked. New runs may adopt prepared intents only after the previous run is finished and its token is revoked.

## Other release channels

OpenJob native/store delivery retains product-specific simulator, provider and physical-device requirements. paletteWOW deployment requires its own qualified provider procedure and confirmed incremental cost. This adapter records those unavailable channel prerequisites rather than running arbitrary provider commands or presenting a draft as published.

The OpenCorp acceptance journey should invoke release tools only when leadership has a legitimate reviewed product release ready. A meaningless release is not a verification requirement. Unit tests use controlled provider and sandbox adapters for interruption, policy, digest, source, cost and idempotency cases; those tests are not evidence of an actual product release.

Provider references: [GitHub release APIs](https://docs.github.com/en/rest/releases/releases), [release asset digests and uploads](https://docs.github.com/en/rest/releases/assets), and [Actions billing](https://docs.github.com/en/actions/concepts/billing-and-usage).
