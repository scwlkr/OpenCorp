# Company state and commands

Vocabulary lives in [CONTEXT.md](../CONTEXT.md); intended behavior lives in [COMPANY.md](../COMPANY.md). This file describes current implementation boundaries.

`CompanyStore` in `src/storage/store.ts` is the application SQLite writer. `src/core/types.ts` defines shared records. The store retains employees, appointments, projects, assignments, runs, decisions, artifacts, actions and knowledge identities. Workers issue commands through an authenticated broker; trusted storage methods are not employee capabilities. Transactions must not span network or model calls.

## Authority and work

Employee actors carry employee/run identity and policy revision. The store checks employment, run status, lifecycle and authority; the broker also binds the native session. Role text cannot grant Owner access or spending. Current code has explicit executive voting, staffing acceptance and completion rules. Those rules describe the present machinery, not a requirement to expand bureaucracy.

Commands cover organization, projects, assignments, decisions, messages, knowledge, role changes and experience. `role.update` writes a role revision and updates the employee record used by scheduler prompts. Editing the vault's employee `role.md` alone does not currently update that active role. The planned Markdown authority bridge must resolve this divergence.

Work claims atomically create employee runs and honor lifecycle, dependencies and resource admission. Runs retain sessions, attempts and results. Recovery preserves work and reconciles process ownership before retrying. Current fault-diagnosis assignments and correction counters exist; they do not yet constitute the intended general, fast, agent-directed learning loop.

Code artifacts, verification and independent reviews pass through broker tools. Artifact approval, assignment completion, merge, release and whole-project completion are distinct current states. The store validates declared acceptance evidence against the corresponding records. Use scoped command help and exported schemas for exact fields; do not duplicate that API catalog in Markdown.

## External effects and spending

`prepareAction` persists intended effect and deduplication identity before dispatch. Dispatch rechecks authority, lifecycle, cost and relevant source requirements. Observed results and reconciliation distinguish confirmed success, confirmed absence and uncertainty. An uncertain send cannot be blindly repeated; an already dispatched result may still be recorded after pause.

`action.approveCost` supports a concrete action and amount. It is not the planned aggregate project/provider/model budget with expiration and enforced total accounting. The default remains no unapproved spending.

## Knowledge and recovery

The vault contains readable Markdown and generated operational mirrors. Search retains source/version metadata; generated mirror edits do not change database authority. Paths reject traversal and external symlinks. `roleVersions` and vault history are current mechanisms; the new direction favors small useful lessons and lightweight rollback, not accumulating records as a goal.

Backup creates a consistent database/vault snapshot with a manifest. Restore requires paused/stopped state, validates the snapshot and leaves work paused. Credentials are excluded. Run revocation and preserved external-effect observations prevent an old backup from silently replaying a send.

## Migration gaps

Fresh bootstrap still seeds three named products, machine-specific repository paths and a local-only mandate. Existing companies retain stored instructions; changing repository documents does not migrate them. Organizational expansion and free hosted routing exist elsewhere, making coherent migration essential. Reassess old assignments while preserving useful employee identities, product work and observed effects. See the [implementation plan](https://github.com/scwlkr/OpenCorp/issues/1).
