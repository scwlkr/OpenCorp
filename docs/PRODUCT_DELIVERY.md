# Configurable product delivery

Management chooses the audience and useful core, delegates implementation and specialist review, then observes an intended user completing actual work. Basic instructions and honest limitations ship with the product. A repository, passing checks or a release receipt alone does not establish adoption. Use existing product tools; keep business judgment in employee Markdown.

## Repositories and checks

`product.register {name, repository, rationale}` registers a local checkout already present in the Owner repository access envelope. The connected GitHub identity and original checkout remain unchanged. Employees cannot grant new repository access. The authenticated Owner command additionally supplies `managerId` and may explicitly authorize a new absolute repository path; this adds only that path to policy and advances its revision. Failed registration leaves policy intact. Merely installing this capability changes no running permissions. `repo_inspect` discovers the actual repository/default branch and creates the existing isolated workspace foundation.

`product.register_internal {name, verificationCommand, rationale}` creates company-owned local software without a public repository prerequisite. Existing internal products and adoption history remain usable. Both paths use ordinary project/assignment, commit, verification and independent review tools.

A repository can supply `.opencorp/product.json`:

```json
{
  "verificationCommand": "npm test && npm run build",
  "release": {
    "target": "github-release",
    "command": "sh scripts/package.sh",
    "assets": ["useful-tool.tar.gz"]
  }
}
```

The verifier runs on the exact artifact in the existing sandbox. Without configuration, retained product verifiers still work. Locked npm dependencies use the existing integrity-checked public artifact cache and offline installation, including sandboxed lifecycle scripts. The current prepared Node runtime is 22.22.3; products must support it. Python/shell may use installed sandbox tools; this does not install arbitrary system packages or permit general network access.

## Release and use

For a public GitHub release, the packaging command receives `OPENCORP_RELEASE_VERSION`. It writes the configured nonempty flat files and a `SHA256SUMS` file to `.opencorp-release-output`. Checksums use `<sha256>  <filename>` lines. Keep README, license and usage instructions in the package as appropriate. The command and asset names come from the exact independently reviewed, merged source. Existing WalkLang packaging remains the fallback when it has no configuration.

Use existing `prepare_release` and `publish_release` tools. They retain connected-account verification, public-repository zero-cost checks, exact merge/tree checks, package hashes, cancellation and uncertain-effect reconciliation. Private repository charging, native store submissions and other hosting require their actual permitted procedure and prerequisites; this configuration does not authorize them. A downloadable public release remains available independently of the company Mac.

For an internal release, `adopt_internal_tool {artifactId, entrypoint, employeeIds}` exposes an independently reviewed, verified version to named employees. Entrypoints may be JavaScript (`.js`, `.mjs`, `.cjs`), Python (`.py`) or shell (`.sh`). `use_internal_tool {productId, args}` uses exact source and prepared dependencies in a fresh sandbox, with arguments passed literally. No credentials/network or persistent shared data directory is supplied. Design stateless inputs/outputs accordingly; do not promise durable storage across invocations. Prior adoption versions remain available for rollback.

Have an intended employee use the adopted tool for a real task, or an intended human install/use the public release. Inspect the actual output and act on feedback. Preserve attribution to employee implementation and review; development-assistant fixtures are only checks.
