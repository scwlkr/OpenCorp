# Inspect employee work

Open the existing Owner workspace with `opencorp open`, choose **Runs**, then an assignment. The view refreshes while work runs. It shows captured instructions and their role/policy revisions, runtime configuration, gateway and provider request bodies, tool calls/results, employee text, routing and timing events, and the recorded outcome. The current assignment record is labeled separately from the instructions actually supplied at run start.

Expand `run.context` and `runtime.configuration` for the initial input. Each `runtime.inference.context` identifies its request number and boundary: the normalized gateway input or the final provider transport body, without headers. Compare requests to inspect observable compaction, removed history and tool changes. A provider's own transformations and hidden internal reasoning are unavailable. Attachments and recognized credentials are redacted. Employee explanations are model-authored statements, not independently verified facts or hidden reasoning.

The displayed diagnosis is the inspector’s interpretation of observed events, not a separate employee claim. Inference and tool waits use start/finish observations; queued or blocked assignments retain their recorded dependency, approval or capacity reasons. Missing evidence means the cause is unknown, not that work is progressing. The latest event time helps identify a stall. Use **Intervene in this assignment** to pause/resume, add subsequent-attempt guidance, replace subsequent instructions, or select the employee’s subsequent model. Provide a reason. The same controls are available on waiting assignments. This view grants no new employee permissions.

The authenticated endpoint is `GET /api/v1/runs/:id/inspection`. It uses the same loopback, Owner bearer/session, origin and cache protections as the workspace. Worker tokens cannot read it. Detailed copies live under the company's `runtime/inspection` directory (0700), in per-run files (0600); never publish these private files or place them in Git. Existing runtime session files and recovery/effect records retain their existing purpose and lifecycle.

Detailed capture stops at 16 MiB per run with an explicit truncation record. The total diagnostic-copy budget is 128 MiB, with newest selected failures preferred, then newest ordinary runs. Ordinary captures expire after seven days. For a failed run, **Keep failure for investigation** (`POST /api/v1/runs/:id/inspection/preserve`) extends eligibility to 30 days, subject to the same total budget. Selection does not create an unlimited archive. Service maintenance, capture writes and reads prune only these diagnostic copies; they never delete execution, session or external-effect recovery records. Old runs without this capture are labeled unavailable.

To assess the inspector, open an actual running employee assignment, inspect a request and its tool result, then observe its recorded outcome. Synthetic privacy/retention checks establish those boundaries only; neither those checks nor one inspected run proves an autonomous company, product delivery or adoption.

## Individual intervention

The existing authenticated `POST /api/v1/command` and `opencorp command '<JSON>'` accept:

- `{"type":"assignment.update","assignmentId":"ASSIGNMENT_ID","paused":true,"rationale":"Inspect the stalled work"}`
- `{"type":"assignment.update","assignmentId":"ASSIGNMENT_ID","guidance":"Use the retained result and report only the remaining limitation","rationale":"Avoid repeating completed work"}`
- `{"type":"assignment.update","assignmentId":"ASSIGNMENT_ID","paused":false,"rationale":"Runtime stopped and pending effects reconciled"}`

Existing `assignment.update` with `instructions` replaces subsequent instructions; acceptance and project scope remain protected. Existing `employee.model` with `employeeId`, `modelId` and `rationale` selects an already permitted model for subsequent employee work. Neither edit changes an already supplied prompt or running model. Pause first when the current attempt should stop. Company pause/Stop and other eligibility gates still apply.

The persisted assignment hold survives restart and sleep. It does not dismiss the employee or hold their unrelated assignments. Active run authority is revoked immediately; cancellation and process cleanup can still be in progress. Resume refuses an active/uncertain previous runtime or dispatched/uncertain effects. Once released, a queued assignment is eligible under normal scheduling; blocked work still needs its existing explained management retry. Releasing a hold does not resolve a blocker or reset retries, provider quotas, approvals or effect receipts.

Recovery retains the assignment, identity, workspace, previous run link and corporate/effect records. The next attempt reads current guidance and preserved progress through existing scoped tools. It is a new runtime attempt, not a guarantee of preserving unrecorded model thoughts. A provider action already sent cannot be undone. Existing provider reconciliation must establish presence or proven absence before a possible retry; unknown outcomes stay held. Never change a deduplication key to evade an uncertain receipt.

Supervising management can use the same `assignment.update` fields through `company_command`, subject to existing assignment authority; `employee.model` still requires its existing employee-management authority. Individual controls grant no additional access or spending.

## Employee inspection and learning

Employees use `company_detail {collection:"runs",id:"RUN_ID",view:"inspection",offset:0}` for a newest-first event index from the same bounded capture, including tool names and statuses so completed results can be selected directly. Supply an `eventIndex` from that index to read its captured content, and follow `nextOffset` within that event if needed. Start with relevant recent outcomes/tool events instead of paging repeated prompts. Capture availability and omissions remain explicit. Existing scoped run access is required, plus own/home-managed work and a local inference route because full captured context may contain private material. Project membership alone does not expose another employee's private context. Pending independent initial governance judgment also blocks full capture. Hosted employees retain scoped record summaries and may ask responsible local management for permitted findings. No worker gains the Owner HTTP endpoint.

Management guidance in `skills/management.md` covers wait diagnosis, permitted alternatives, retained ownership, intervention and concise lesson adoption/reversal through existing `update_role` and `roleVersions`. Two comparable failures prompt reconsideration, not a mechanical cutoff. Observe the subsequent employee turn and useful result before calling the lesson effective.

Focused fault turns receive `skills/recovery.md` in place of broad management guidance and generic role seeds. Company-only faults use the existing corporate-only runtime/tool path; project faults retain workspace tools. Approved employee skills, the current assignment, protected authority, scoped evidence and checkpoint validation remain in force.
