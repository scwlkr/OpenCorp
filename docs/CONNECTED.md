# Connected application capabilities

OpenCorp uses installed Playwright MCP 0.0.80 and macOS Automator MCP 0.4.7 from its own service. These adapters do not depend on the builder's browser or Codex session.

## Product previews and inspection

`prepare_preview` receives a directory relative to the current product workspace, and an optional relative HTML entry (`index.html` by default). The broker supplies the employee run, validated product workspace, and a callback that rechecks run authority and current policy. The model cannot choose those values.

The adapter observes a snapshot of HTML, CSS, ordinary images, fonts, and text documentation. Its receipt contains the run-owned preview ID, exact loopback URL, file/byte counts, and a SHA-256 digest over the included paths and contents. It binds an ephemeral listener only to `127.0.0.1`. Rebuilding replaces that run's previous preview and browser session.

The listener:

- Serves immutable in-memory files using GET/HEAD, without directory listings or any build, executable, API, or write endpoint.
- Refuses hidden/credential/dependency paths, traversal, symlinks, hard links, unrelated hosts/origins, and unsupported file types. Source descriptors are checked before bounded reads so a concurrent path replacement cannot expose another file.
- Caps snapshots at 500 included files, 8 MiB per file, 32 MiB total and 2,000 visited entries.
- Uses CSP to disable JavaScript, external resources, requests, frames, forms, plugins, and sensitive browser permissions. Inline CSS and local images/fonts are supported. This is a static documentation/UI preview; JavaScript applications and development servers require a separate scoped adapter.
- Rechecks run authority for every read. Run completion, cancellation, pause/stop, or daemon shutdown closes the listener. It has no standalone process to survive a daemon crash.

`macos_action` with `open_preview` and the current run's preview ID opens the exact prepared URL in that run's isolated Playwright browser. It does not open Safari, the Owner's personal Chrome profile, or an arbitrary localhost service. `browser` supports navigation, DOM snapshots, native PNG/JPEG screenshots, clicks, navigation keys, and isolated tabs. Screenshot and snapshot file paths are chosen by the broker. Screenshots are returned as real MCP image content for a vision-capable local model; merely obtaining a screenshot is not evidence that a text-only model visually reviewed it.

Public research still uses the explicit `researchHosts` HTTPS allowlist in `src/tools/connected.ts`. Research and static preview use separate isolated browser contexts. The preview context admits only the current run's prepared preview origin; even an allowed public research host is unavailable to the static document. Explicit broker navigation selects the corresponding context. Browser interception independently checks every request and redirect, blocks non-GET/HEAD methods and WebSockets, strips authentication/cookie headers, and cancels downloads. A fresh isolated profile has no Owner cookies, sessions, or browsing history. There is no general JavaScript evaluation, upload, arbitrary key chord, script, or file-read tool.

`fetch_public` accepts an optional character `offset` and `limit` (6,000 by default, capped at 12,000). It observes at most 100,000 source bytes, reports the observed size, and explicitly identifies any unobserved source tail. `nextOffset` pages only the observed prefix; a null next offset does not imply complete source content when `sourceTruncated` is true. Each request fetches the current public resource again, so it is not an immutable source archive.

## macOS actions

`system_version` invokes the fixed macOS Automator system information script. `reveal_path` reveals a relative path from the assigned product workspace in Finder using fixed JXA with a safely encoded path. It rejects outside, hidden, credential, symlink, and hard-linked file paths. It does not open or execute the file and cannot accept arbitrary AppleScript/JXA. The broker rechecks current authority after MCP initialization and immediately before dispatch.

The doctor checks the installed macOS MCP tool catalog without invoking Finder or requesting Automation consent. An actual Finder reveal can report a macOS Automation permission requirement; the adapter cannot grant OS consent. Native application control beyond these three operations is unavailable in the first release. Prefer existing product provider APIs and repository adapters for releases and communications.

## Runtime integration

`ConnectedScope` is trusted broker input: `{runId, workspace, assertActive, signal?}`. Application methods are `preparePreview(scope, {path?, entry?})`, `macos(action, arguments?, scope?)`, and `browserTool(name, arguments, scope?)`. The scheduler must invoke `closeRun(runId)` when the run ends; `close()` terminates all current application sessions. An abort signal also closes the matching preview/browser. Neither API creates a spending allowance or invokes paid inference.
