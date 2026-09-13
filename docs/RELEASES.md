# Product release adapter

`ProductReleases` in `src/tools/releases.ts` prepares and publishes reviewed artifacts through a credentialed broker. Employees receive scoped tools, not credentials or the protected package spool. [Company direction](../COMPANY.md) calls for broadly usable releases; this adapter is currently specialized.

## Implemented path

WalkLang preparation checks the reviewed and merged source, creates an isolated worktree at that immutable commit, and runs its existing build/check/release procedure in the native sandbox. It checks current-host binaries, version and package checksums, preserves the source checkout, and retains a protected manifest and build output. This is current-host packaging, not proof of cross-platform availability.

Publication rechecks source identity, authority, lifecycle and cost eligibility. Durable intents separately cover tag creation, draft metadata, asset upload and publication. It observes matching provider state and package digests before declaring success. Foreign or conflicting tags/assets are not overwritten. Uncertain results require reconciliation, not blind retries.

A pause prevents subsequent effects but cannot undo a request already sent. Prepared releases may be resumed only with valid ownership and authority. Unit fixtures establish adapter behavior, not an actual public release.

## Limitations

Other products require a supported release procedure and confirmed provider prerequisites. OpenJob native/store publication retains simulator, provider and physical-device requirements; there is no generic store submission. Arbitrary web hosting is not implemented by this adapter. Public products remaining available independently of the Mac is a design requirement to implement using suitable hosting, not a current universal guarantee.

Use existing build/deployment tools and Markdown release guidance where possible. Add executable adapters only for necessary missing capabilities and boundaries. A release must serve an actual product need; it is not busywork for an acceptance record. See [delivery](DELIVERY.md) and the [implementation plan](https://github.com/scwlkr/OpenCorp/issues/1).
