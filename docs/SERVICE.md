# User service installation and replacement

`opencorp service install` installs the company LaunchAgent using the pinned Node executable and absolute application paths. Reinstallation preserves the company database, workspaces, and persisted running/paused/stopped policy. It does not send a company start or resume command. Existing unrelated files or symlinks at `~/.local/bin/opencorp` remain protected by the existing installation check.

Replacement reconciles launchd registration rather than treating every nonzero `launchctl` exit as absence:

1. Read the exact `gui/<uid>/<company-label>` registration. Unknown results stop replacement.
2. Boot out an existing registration and wait up to ten seconds for confirmed removal. Wait for a previously healthy OpenCorp daemon to stop before starting its replacement.
3. Bootstrap the installed plist. If bootstrap returns an error or its transport fails, read the registration again.
4. If the job registered, wait for health from the PID shown by launchd. A healthy old/disconnected daemon does not establish successful installation. An existing registration is never bootstrapped again to address an unhealthy process.
5. Only exit 113 with launchctl's explicit `Could not find service` result for the exact company label permits one retry. Wait one second and confirm absence again immediately before retrying; a registration that appeared during backoff is reconciled instead.

There are at most two bootstrap dispatches per install call. Unknown registration or a second failed dispatch is reported without another retry. Health reconciliation is bounded to thirty seconds and reports the service log path if the registered daemon does not become healthy. The result remains visible through `opencorp service status`; startup diagnostics are in `<data-root>/logs/service.log`.

The focused regression suite in `tests/service.test.ts` uses temporary filesystem fixtures and mocked launchctl, HTTP health, and process signals. It tests the observed bootstrap error-5 race, asynchronous removal, late or uncertain registration, matching-PID health, the single-retry bound, and unrelated executable preservation. It never changes the installed company service.
