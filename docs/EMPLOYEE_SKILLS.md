# Approved employee skills

`employees/<id>/role.md` in the company vault supplies an employee's approved skill. `update_role` (or `role.update`) is the existing management approval operation. Submit the complete Markdown, a truthful source and a short rationale; keep new instructions within 12,000 characters. Exact previously approved longer skills remain eligible for rollback. Responsible home management and the Owner can approve it under existing authority checks.

The next dispatched turn receives the complete approved skill, shared working guidance, the current assignment and scoped knowledge. Existing pinned source references retain their attribution; retrieve additional source details only when useful. An already dispatched turn retains its supplied instructions. Run inspection shows the supplied text and revision.

SQLite indexes the approved path and hash and retains immutable revision snapshots for recovery. The employee's `role` read field is a projection, not another authoring surface. A changed, missing or unreadable file uses the last approved snapshot. A manual edit is a draft: responsible management must inspect it before approving its full content through `update_role`. `knowledge.write` cannot replace the role file. A failed update cannot activate unapproved bytes.

To reverse a revision, read the employee's prior `roleVersions` record through `company_detail`, then call `update_role` with that record's content, its ID as source and the reason for reversal. The version number advances; identity, appointments, current work and permissions stay intact. No separate rollback workflow or approval form is needed. Record proposed lessons through `write_knowledge` or send them to the responsible manager.

## Recoverable company improvements

Use a concrete product-work failure to choose the smallest change. An employee can author a focused lesson; a relevant colleague reviews its source, usefulness and authority limits before the responsible manager adopts the complete revised role. Record actual authorship and any developer assistance. Keep the prior approved content available, and inspect the next useful task's supplied revision and result. An approved file alone does not establish that the obstacle was removed.

For recovery, coordinate affected assignments through existing individual pause/resume controls, preserving their prior state. Restore only the changed role through `update_role`, verify the returned revision and approved content, and resume deliberately. Reapplying the reviewed improvement uses the same operation. Do not restore a whole-company backup to undo a skill change: unrelated work and effect receipts must survive.

Executable internal tools use existing independent artifact review, `adopt_internal_tool` and `rollback_internal_tool`; see [product delivery](PRODUCT_DELIVERY.md). Source/service changes require the repository's review and release procedure, a retained known-good build and supported service installation against retained company data. Reconcile dispatched effects before retrying work after interruption. Neither installation nor a rollback grants permissions, credentials or spending. Finish the bounded improvement and return capacity to product delivery.

On first initialization after upgrade, retained active role text is adopted as the existing revision. Stale seeded or manually edited role Markdown is preserved in the vault's existing history before replacement. This migrates the instruction source only; retained company mandates and obsolete assignments require the separate direction-migration issue. Backups retain the Markdown and revision snapshots together.
