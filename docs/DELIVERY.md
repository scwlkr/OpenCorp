# Exact artifact delivery and issue acceptance

`deliver_product` publishes a separately reviewed artifact. `issueNumber` is a
nonclosing reference and requires `remainingGate`: the concrete work or external
prerequisite that the wider issue still needs. OpenCorp includes that statement
in the PR and its observed default-branch evidence comment. A partial assignment
can be approved and delivered while its broader project and issue remain open.

`communicate` takes direct `kind`, `content` and `dedupeKey` arguments. Both
`issue_comment` and `pr_comment` also require `number`, the actual target issue
or PR number; `issue_create` omits `number`. Employees choose the accurate content
and stable message key. Missing comment targets are rejected before an intent or
provider call; a rejected call is not posted communication.

## Existing pull requests

Management can inspect `repo_pr({productId, number})` and create a finite
implementation assignment with `payload.pullRequest: {number, headSha}`. The
supervisor prepares an isolated candidate worktree for that exact provider head
before the employee starts. This preserves the project's existing workspace and
unfinished work. A changed provider source requires a fresh candidate and review;
OpenCorp does not reset a dirty candidate or silently adopt a different head.

The assigned employee uses `import_pull_request({summary})` to retain that
candidate as a commit artifact. `sourcePullRequest` records the original PR,
author, repository, base and head; `reviewWorkspace` records its physical check
location. The employee/run identify the importer, not the source-code author.
`commit_work` is unavailable in an imported-PR assignment. Necessary code changes
return to management for an appropriate separate implementation assignment.

Canonical verification, complete artifact inspection and independent review use
the candidate workspace. After those checks, `deliver_product` binds the existing
PR without pushing another branch or creating another PR. Normal exact-source,
provider, issue-scope and cost checks still apply to merge. Observed imported
merges retain their delivery history without advancing the main project
workspace. WebUI and TUI show the external PR author and importing employee;
imported code does not satisfy the first release's employee-authored artifact
acceptance checks.

## Issue closure and delivery history

Full issue closure is explicit: `closeIssue: true`. Before it is available, an
independent reviewer reads the complete current issue using
`repo_issue({productId, number, live: true, offset})`, following
`nextUninspectedOffset` until `inspectionComplete`. The returned `issueIdentity`
hash binds the repository, issue number, title and body. In `review_work`, the
reviewer supplies `issueAcceptance: {issueNumber, issueIdentity, scopeRationale,
criteria: [{criterion, rationale, evidence}]}`. Each criterion quotes the actual
issue body, every Markdown checklist item is covered, and the independent
explanation addresses the entire issue, including requirements outside its
checklist. This is a recorded correctness judgment, not proof inferred from a
passing test command. The review retains the actual issue snapshot, exact
artifact identity, reviewer, and run. Changed issue text requires a fresh review.

Publication and merge recheck that exact issue scope. Caller PR titles/bodies
cannot supply closing directives, including cross-repository references; only
the broker emits the one reviewed closing line. Merge rechecks live PR text and
supplies a controlled squash commit message, so prior commit-message directives
cannot silently close other issues. These guards follow GitHub's documented
[closing keyword behavior](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue).

`project.deliveryHistory` retains one receipt per artifact in publication order;
`project.delivery` remains the latest receipt for compatibility. A receipt binds
the artifact/commit to its unique publication branch, PR, push/publication/merge
actions, observed merge commit and default-branch ancestry. Issue evidence
comments have their own durable action ID. `deliveriesFor` includes legacy
single-delivery records without discarding them. Retries use the selected
artifact's receipt; publication, polling and completion checkpoints cannot use
another artifact's earlier PR. New milestones wait for the previous publication
and issue evidence to finish. Project completion separately requires its actual
acceptance evidence; a merge does not mark the whole project complete.

After merge, OpenCorp advances its own clean workspace from the exact reviewed
head to the observed squash commit, checking tree equivalence first and retaining
an advancement intent. Changed work is preserved for reconciliation. While advancement is unfinished, all product-project native runs are held, including management, assessment and conversation. Only an exact scheduler-authored delivery continuation may dispatch: it re-observes the merge and completes broker advancement before inference is admitted. A retained interrupted continuation is reused; if none remains, the scheduler creates one stable continuation without replaying external effects. Both scheduler selection and atomic run claiming apply this boundary. If the trusted continuation fails, its supervisor diagnoses the exact failed run from a company workspace, with read-only project evidence through the broker. A queued diagnosis from an older project-bound route is relocated without duplication. Product native writes stay held; the diagnosis must record a correction or an actual prerequisite, and never blindly repeats external effects. Each
artifact retains its original `baseCommit`; later workspace advancement does not
rewrite historical review diffs. Releases select the requested artifact's merged
receipt, including an earlier milestone. A supplemental independent review can
inspect an already approved immutable artifact to add truthful acceptance
coverage without reopening or rewriting the original completed assignment.


A bounded WalkLang CI qualification permits an existing literal
`jobs.test.env.WALK_RELEASE_VERSION` in `.github/workflows/ci.yml` to change
between valid `v`-prefixed semantic versions. Complete original UTF-8 YAML is
parsed and compared; every other key/value, job, runner, action, step, permission,
and environment setting must match. No workflow additions, deletions, renames,
mode changes, expressions, or other products receive this exception. The same
comparison runs against both the artifact's immutable review baseline and the
current default branch immediately before publication/merge. Cost receipts retain
both commit identities, source hashes and literal versions. Existing live public
visibility checks and the standard-runner/action restrictions still apply.
GitHub documents [standard hosted runners as free for public repositories and
larger runners as charged](https://docs.github.com/en/billing/concepts/product-billing/github-actions);
this version-input exception does not permit changing charging-related settings
or bypass exact-artifact verification and independent review.

Artifact approval remains sufficient readiness for the existing verified delivery pipeline. It does not complete the originating implementation assignment: exact manager-declared criteria, independent assignment coverage and observed receipts determine that separately. An honest partial maintenance release can proceed while broader or external-PR requirements remain unmet; neither delivery nor a reviewer summary rewrites the original acceptance.
