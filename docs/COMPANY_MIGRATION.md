# Retained company direction

Issue #4 adopts the approved software-factory direction in an existing company through the shared Owner service. New companies start directly in this direction and seed their mandate from [company direction](../skills/company-direction.md). Registered repositories remain the actual access envelope; neither choosing a new venture nor this migration grants repository access.

For an existing company, pause through `opencorp pause`, wait for active turns to drain, and create `opencorp backup`. Run `opencorp command '{"type":"company.migrate"}'`, inspect the retained records, then deliberately resume if appropriate. The command requires Owner authentication and a paused/stopped company. It is idempotent. It does not start another company, change policy or automatically resume work.

The migration preserves the former mandate in SQLite and prior mandate Markdown in existing vault history. SQLite holds the active mandate; the vault copy is synchronized after the transaction and repaired at initialization or command retry. Approved employee skills remain intact. Every subsequent employee turn receives the current mandate, which supersedes obsolete business requirements while preserving specialty and unchanged permissions.

Unfinished automatically generated founding, executive-start, office, department, recruiter-bootstrap and vacancy-request tasks are retained as blocked for management reassessment. Their original instructions and acceptance remain available. A single CEO task asks management to preserve useful commitments and dispose of obsolete administrative work through existing commands. Fixed coverage and vacancy generation stop; already authorized recruitment, onboarding, votes, product work, duties and optional management-created events retain their existing mechanisms. No pending approval or uncertain effect is converted into success or retried by migration.

Management uses the same tools to review old skills, duties and event schedules against actual needs. No staffing or social quota is imposed by the new mandate. Operational concurrency, spending, model allowlists and permissions remain unchanged; general scheduler simplification and new delivery capabilities are separate work under spec #1.

The focused regression checks cover Owner-only migration, draining, preservation, repeat calls and reopening. Actual retained work must also be observed through the installed service; these checks alone do not demonstrate useful operation.
