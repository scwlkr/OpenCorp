# Repository delivery

This describes the current broker pipeline. Product choice and operating intent belong in [COMPANY.md](../COMPANY.md); simplifying this pipeline belongs in the [implementation plan](https://github.com/scwlkr/OpenCorp/issues/1).

`deliver_product` publishes an independently reviewed artifact with canonical checks at its exact source identity. Review readiness, assignment completion, issue closure and deployment are different facts. A merge alone does not make a usable product.

## Existing pull requests

Management can inspect `repo_pr` and assign an exact `payload.pullRequest: {number, headSha}`. The supervisor prepares a separate candidate workspace. `import_pull_request` retains external authorship; the importer is not credited as code author. Verification and independent review inspect that exact candidate. Delivery can bind the existing PR without creating another. Source drift requires a fresh candidate and review; dirty work is preserved.

## Issues and communications

`communicate` currently supports repository communication, including issue/PR comments. It is not Telegram or email. Direct arguments identify kind, content and a stable deduplication key; comments require the actual issue/PR number.

A delivery's `issueNumber` is a nonclosing reference requiring a concrete `remainingGate`. `closeIssue: true` requires independent inspection of the current complete issue and recorded coverage bound to its identity. Changed issue content requires renewed inspection. The broker controls closing directives so unrelated issues cannot close through caller text or commit messages.

## Effects and completion

Delivery history binds each artifact to its publication actions, PR and observed merge/default-branch state. Effects persist intent before dispatch and reconcile uncertainty before retry. Live source, authority and cost checks occur before writes. An earlier artifact's receipt cannot stand in for a later delivery.

After merge, the broker advances its own clean workspace only after confirming the reviewed tree matches the observed merge tree. Unfinished advancement holds product native work until reconciliation. Historical review bases remain unchanged. Project/assignment acceptance is evaluated separately; honest partial delivery leaves unmet work open.

The current CI cost qualification includes a narrow WalkLang release-version exception. It is product-specific, not permission to alter arbitrary workflows or assume a provider is free. Inspect `src/tools/` and `src/core/delivery.ts` for exact current guards.

General hosting and lifecycle maintenance still need integration. Reuse existing provider tools with agent-authored procedures; retain executable controls where identity, credentials, spending and irreversible effects require them. See [releases](RELEASES.md).
