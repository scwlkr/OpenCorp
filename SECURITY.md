# Security policy

OpenCorp controls local processes, repository workspaces, and connected provider actions. Authorization, sandbox escape, credential exposure, and uncertain-action replay defects are security-sensitive.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** option to submit a private report. Include the affected commit, prerequisites, reproduction steps using disposable data, and expected versus observed behavior. Do not include live credentials or private company databases.

If private reporting is unavailable, open a public issue requesting a private contact without disclosing exploit details or sensitive data.

## Supported versions

During developer preview, fixes target the latest default branch. There is no guaranteed response time or long-term support commitment.

Keep the Owner token private, keep the service on loopback, and use separate disposable company data for testing. See [runtime boundaries](docs/RUNTIME.md) and [connected capabilities](docs/CONNECTED.md).
