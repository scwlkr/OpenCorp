# Contributing to OpenCorp

OpenCorp is an early, macOS-specific project. Focused bug reports, documentation improvements, and well-scoped changes are welcome. Discuss broad portability or product-adapter changes in an issue before implementing them.

## Development

Use Apple Silicon macOS and Node 24.20.0:

```sh
npm ci
npm run verify
```

The verification command runs type checks, lint, tests, and the production build. Native sandbox tests require macOS and Apple command-line developer tools. Real-model checks require the artifacts described in [docs/RUNTIME.md](docs/RUNTIME.md); do not run installed-company acceptance checks against someone else's working company.

## Pull requests

1. Create a branch for one focused change.
2. Add regression coverage for behavior changes and update affected documentation.
3. Run `npm run verify` and `git diff --check`.
4. Explain the problem, resulting behavior, verification performed, and any remaining limitations.

Preserve authority boundaries, cancellation, and recovery evidence. Test fixtures must not be described as actual autonomous product delivery. Do not add cloud inference fallback or new spending without explicit product decisions.

## Keep private data out of Git

Use disposable data directories outside the repository. Never commit company databases, tokens, model weights, logs, private workspaces, personal plans, or generated acceptance reports. Before committing, review `git diff --cached` and `git status --short`. Scrub paths, credentials, and private company details from issue reports.

Contributions are provided under the project's MIT license. Preserve third-party license notices and provenance.
