# Verification

The outcome is usable, adopted software. Tests support confidence in it; tests, logs and activity are not the company's product. [COMPANY.md](../COMPANY.md) defines success; the [implementation plan](https://github.com/scwlkr/OpenCorp/issues/1) identifies missing capabilities.

Owner clarification for [specification #1](https://github.com/scwlkr/OpenCorp/issues/1): emphasize real company operation through the existing shared service. Keep new automated checks narrow, for consequential spending/access/recovery boundaries or concrete regressions. Do not create tests for each story or merely to mirror Markdown instructions.

| Command | What it checks |
| --- | --- |
| `mise exec node@24.20.0 -- npm run verify` | Types, lint, automated tests and production build. |
| `mise exec node@24.20.0 -- npm run verify:local-runtime` | Real OpenCode/local-model tool work, independent review, image inspection and cancellation in disposable workspaces. |
| `mise exec node@24.20.0 -- npm run verify:corporate-runtime` | Corporate tools through actual local inference against a disposable company. |
| `mise exec node@24.20.0 -- npm run verify:acceptance` | The existing installed-company journey and persisted delivery/control/recovery evidence. |

Inspect each script's prerequisites before running it against an installation. Fixtures do not establish production delivery, hosted-model qualification or user adoption. Do not author product work manually and attribute it to company employees.

The existing acceptance script reflects the older portfolio-specific journey: employee-authored delivery plus a second-project checkpoint and operational controls. Its imported-PR route preserves external authorship. These checks remain useful regression evidence; passing them does not establish the complete new factory. Update acceptance coherently with the implementation rather than treating its old scenario as permanent product scope.

Use proportionate checks for the actual change: working core workflow, appropriate independent inspection, deployed or installable output where relevant, and observed use. Check spending, permissions and recovery where an implementation changes those boundaries. Avoid adding a general scoring, tracing or proof-production system.
