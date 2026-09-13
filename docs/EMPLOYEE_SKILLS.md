# Approved employee skills

`employees/<id>/role.md` in the company vault supplies an employee's approved skill. `update_role` (or `role.update`) is the existing management approval operation. Submit the complete Markdown, a truthful source and a short rationale; keep new instructions within 12,000 characters. Exact previously approved longer skills remain eligible for rollback. Responsible home management and the Owner can approve it under existing authority checks.

The next dispatched turn receives the complete approved skill, shared working guidance, the current assignment and scoped knowledge. Existing pinned source references retain their attribution; retrieve additional source details only when useful. An already dispatched turn retains its supplied instructions. Run inspection shows the supplied text and revision.

SQLite indexes the approved path and hash and retains immutable revision snapshots for recovery. The employee's `role` read field is a projection, not another authoring surface. A changed, missing or unreadable file uses the last approved snapshot. A manual edit is a draft: responsible management must inspect it before approving its full content through `update_role`. `knowledge.write` cannot replace the role file. A failed update cannot activate unapproved bytes.

To reverse a revision, read the employee's prior `roleVersions` record through `company_detail`, then call `update_role` with that record's content, its ID as source and the reason for reversal. The version number advances; identity, appointments, current work and permissions stay intact. No separate rollback workflow or approval form is needed. Record proposed lessons through `write_knowledge` or send them to the responsible manager.

On first initialization after upgrade, retained active role text is adopted as the existing revision. Stale seeded or manually edited role Markdown is preserved in the vault's existing history before replacement. This migrates the instruction source only; retained company mandates and obsolete assignments require the separate direction-migration issue. Backups retain the Markdown and revision snapshots together.
