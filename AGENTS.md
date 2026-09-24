# OpenCorp

## Read first

**September 24, 2026 Owner hold:** OpenCorp is dormant until the Owner explicitly authorizes reactivation. Do not start or deploy its runtime, agents, scheduled work, or owner-email relay. Do not re-enable the macOS LaunchAgent, Cloudflare email rule, or Worker URLs. Read-only inspection and preservation of existing assets are allowed. [WLK-9](https://linear.app/wlkr-labs/issue/WLK-9/pause-opencorp-runtime-and-disconnect-owner-email-relay) records the shutdown. This hold supersedes older instructions to continue work.

[COMPANY.md](COMPANY.md) is the Owner-approved operating charter. [Implementation specification](https://github.com/scwlkr/OpenCorp/issues/1) is the complete implementation plan. Read [CONTEXT.md](CONTEXT.md) and relevant [ADRs](docs/adr/) before changing the model. These replace the former constitutions, organization chart and expansion plans.

## Mission and organization

Build a persistent, autonomous software factory whose products are actually used by people or agents. Leadership chooses products and ventures, with a slight early preference for useful internal tools. Users come before revenue; products endure through release, feedback, support and maintenance. Discuss the complete intended company, not a reduced first-release vision.

Preserve a large specialized organization across the full product lifecycle. Owner → three Elders → CEO → C-suite → department leads → project managers → workers defines responsibility, not a mandatory chain of routine approvals or messages. Let agents reason, collaborate directly and choose efficient methods. No arbitrary organization cap, required headcount or social-activity quota.

Employees have persistent identities and evolving skill files; models are replaceable engines. Elders appoint and judge executives. Management develops, hires, reassigns and dismisses staff according to useful outcomes. Organization size must not be confused with simultaneous inference capacity.

## Markdown before code

Before every code addition ask: **Does this code absolutely need to exist, or can Markdown instructions and existing tools do this?**

- Express business behavior in concise skills and guidance: strategy, delegation, research, communication, review, learning and recovery. Do not encode ordinary company judgment as rigid workflows or completion forms.
- Reuse established runtimes, SDKs, MCP tools, connectors and CLIs. Preserve useful OpenCode/MCP foundations; evaluate OpenClaw as a reference, not a required dependency.
- Keep necessary execution, message transport, persistence/recovery, resource controls, verified approvals and permission/spending enforcement in code. Prefer general capabilities over product-specific machinery.
- Make approved skill Markdown actually guide employee turns. Keep SQLite as operational truth for identities, appointments, permissions and execution, without a second independently editable instruction source.
- Reuse suitable skills from `skills/vendor/agency-agents`, preserving attribution. Roles describe competence, not authority. Load relevant instructions and lessons rather than entire company histories.
- Improve skills rapidly with concise lessons and lightweight rollback. Two similar failures should prompt adaptation, not identical retries or a new scoring framework.
- Judge real product behavior and adoption through inspection, feedback and relevant checks. Do not build a testing, tracing, proof or memory bureaucracy.
- Agents may improve OpenCorp through reviewed, recoverable changes; they cannot expand their own permissions or spending.

Provide focused live run inspection and authorized individual controls through existing service/runtime foundations. Expose supplied context, model/configuration, actions, outputs and stalls; distinguish observations, employee explanations and inferred diagnoses. Keep detailed recent records bounded and protected; management uses the same tools within its permissions.

Small models earn broader assignments through useful work. Tune concurrency for useful completions and turnaround, including rework; no fixed swarm size. Prefer focused context and skill-based specialization before justified weight fine-tuning.

## Resources and Owner relationship

Use local compute and permitted free hosted inference, selected by task capability, tools/context, allowance, latency and actual load. Provider catalogs and limits must remain configurable and current. Respect cooldowns, save progress and reconsider recovered capacity without busy polling or paid fallback.

High Mac utilization is acceptable. Provide Full power, Low power and Stop; persistent idle employees need no inference. Low power retains suitable lightweight/hosted work while minimizing local load. Preserve progress through sleep and interruption. Public products should remain available independently of company controls or Mac sleep.

The CEO is the primary Owner contact through Telegram and email. Use quick Telegram exchanges and proposal-specific approvals, daily concise email reporting and substantive emailed proposals. Share management context so the Owner does not relay messages between employees. Owner controls must not require a dashboard.

Unapproved spending is $0. Paid proposals specify named work, providers/models, total cap, expiry, estimate basis, uncertainty and free alternatives. Enforce approved scope and ceiling; estimates do not guarantee delivery.

## Authority and blocked work

Owner approval is required for spending, monetary commitments, destructive actions and legal commitments. Routine work, organization, new ventures, free resources, ordinary communications and production delivery proceed within granted authority. Keep credentials outside model context. Private Owner/customer data requires an explicitly permitted route.

When an approach is blocked, seek another permitted way to achieve the same outcome before setting it aside. Do not evade the underlying restriction. Continue other useful work if alternatives are exhausted; silence never grants approval. Preserve existing users when pausing product investment.

This development direction does not itself grant credentials, change a running company's permissions, authorize spending or deploy software.

## Current implementation

The source already includes local and free hosted adapters, persistent state, approved Markdown skill revisions with recovery, OpenCode/MCP and limited delivery tools. It still has fixed bootstrap defaults and scripted company workflows. Telegram/email, Low power, scoped paid budgets and generalized product delivery remain plan work.

Update runtime policy, routing, prompts, skills and retained company state coherently. Preserve useful identities and work; simplify obsolete machinery. New documentation or fresh-install defaults alone do not migrate an existing company.


## Git checkpoints and sensitive information

Owner instruction recorded 2026-09-13. Applies to every active work session in this repository, including existing worktrees.

- At session start, inspect branch, working-tree status, recent commits and configured remotes. During active work, perform a Git checkpoint at least every 60 minutes, and before stopping or handing off. Record the checkpoint time, what was committed or reason no commit was needed, and scan result in the existing progress/handoff note; never create empty commits merely to satisfy the interval.
- Commit coherent, reviewable progress frequently. Stage exact intended paths, review the complete staged diff and new files, and preserve unrelated work. Never use blanket staging or include another worker's changes without reviewing and coordinating them.
- Before EVERY commit, run `gitleaks git --pre-commit --staged --redact --no-banner` from that checkout, in addition to manually reviewing the staged content for sensitive information. If Gitleaks is unavailable, restore it or use an approved equivalent before committing. A passing scanner is supporting evidence, not a guarantee.
- Never commit real API keys, passwords, access/refresh tokens, private keys, credential stores, populated environment files, private personal/customer data, runtime databases, raw provider responses, or logs/screenshots containing sensitive data. Keep these outside Git; use unmistakably synthetic placeholders in examples and tests. Review newly generated files explicitly. `.gitignore` does not protect files already tracked.
- If a scan or review finds sensitive material, stop that commit/push, remove or redact it without destroying unrelated work, and rerun the checks. Never suppress a real finding just to pass. Review suspected false positives individually; do not broadly disable rules. Report exposed credentials without reproducing their values and arrange revocation/rotation; deleting the current file alone does not remove prior Git history. Do not force-push or rewrite shared history without explicit authorization.
- At each checkpoint, sync completed commits to an existing authorized remote/branch when configured, after reviewing and scanning the outgoing commit range with Gitleaks in redacted mode. Preserve branch/review/merge requirements. If no remote exists, retain local commits and state that they are local only; do not create a remote, publish the repository, or claim a push occurred. Report push failures and remaining unsynced work clearly.
- This is a rule for agents while working, not an hourly background job. It does not resume stopped goals, create work while idle, or authorize additional spending or publication.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `scwlkr/OpenCorp`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

## Linear work queue

- Team: **WLKR LABS**.
- Project: [OpenCorp](https://linear.app/wlkr-labs/project/opencorp-69009ff28d59).
- Linear is the task source of truth. Existing GitHub issues and Markdown plans are historical context; this section supersedes older tracker or backlog guidance.
- Before starting substantive work, read the Linear issue and discussion and check for existing work. Find or create a Linear issue for substantive user-requested work, not every question or minor action.
- Keep status current, include the issue ID in branches and PRs, and post concise outcomes or blockers. Mark Done only when completion criteria are met.
- Do not maintain a competing Markdown backlog or import or sync GitHub issues.
