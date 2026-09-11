# Owner interfaces

All four interfaces read and mutate the same local company service. Closing an interface leaves the company running. Pause, stop, and the $0 unapproved spending restriction are enforced by the backend.

## Open the company

Run `opencorp open` for the authenticated WebUI or `opencorp tui` for the live terminal interface. The executable uses the pinned Node 24.20.0 installation and the built application. `opencorp --help` and `opencorp <command> --help` describe each command.

`opencorp status --json` reports actual company state. CLI connection discovery uses `OPENCORP_DATA_DIR` or `--data-dir <path>`; the default is `~/.local/share/opencorp`. Discovery is restricted to HTTP on 127.0.0.1. The Owner token is read locally and never included in command output. Do not share the owner-token file or authenticated login link.

## WebUI

- Overview: standing mandate, portfolio priorities and reasons, current work, delivered artifacts, Owner attention, actual inference slots, events, and lifecycle controls.
- Products: assessments, goals, roadmaps, repository paths, projects, releases, and communication receipts. An unconfirmed action explicitly has no confirmed remote result.
- Projects: finite outcomes, acceptance conditions, supervisors, workspace identity, assignments, dependencies, runs, artifacts, independent reviews, and attributed discussions.
- Organization: departments, people, positions, vacancies, reporting, appointments, governance reasons and dissent. Employee detail includes stable identity, current model, role/history, responsibilities, experience, and messages.
- Conversations: persistent CEO, employee, and project conversations. Saving a message does not claim an employee response. Replies appear only after actual work creates them.
- Knowledge: vault search, Markdown, sources, version, and human-edit metadata. Operational authority cannot be changed by narrative text.
- Attention: exact prerequisites and concrete action-scoped cost approval. No blanket allowance control exists.
- Settings: policy, scheduling bounds, current model artifacts/capabilities, integrations, resource details, doctor, backup/restore, and lifecycle controls.

Keyboard navigation uses normal links, buttons, labels, and disclosure elements with visible focus. A skip link focuses main content. Layout adapts to narrow screens. Background connections refresh from server events and every five seconds; the last received state stays visible during service interruption. Authentication expiry directs the Owner to `opencorp open`.

## CLI

Commands: `init`, `start`, `status`, `pause`, `resume`, `stop`, `open`, `tui`, `chat`, `products`, `projects`, `employees`, `decisions`, `attention`, `models`, `integrations`, `logs`, `doctor`, `backup`, `restore`, and `service install|uninstall|status`.

```sh
opencorp status --json
opencorp projects --json
opencorp chat "What changed in the portfolio?"
opencorp chat --project PROJECT_ID "Keep this acceptance requirement."
opencorp pause
opencorp resume
opencorp backup --json
opencorp restore /absolute/path/to/backup
opencorp service status --json
```

Machine-readable errors are `{ "error": { "message": "..." } }` with a nonzero exit status. Actual results and backend policy errors are propagated. `init` starts the service and bootstraps state; `start` explicitly starts work. Service uninstall retains company data.

## TUI

A real terminal is required. The TUI reconnects after daemon restart and preserves the current view and draft. It uses event notifications and periodic snapshot refresh through the same authenticated API client as the CLI.

- Tab / Shift+Tab, or 1–7: overview, products, projects, employees, decisions, attention, CEO chat.
- Up/down: select records. Enter opens details. Escape returns to the list.
- Up/down and Page Up/Page Down: scroll long detail and overview content.
- `p`: pause. `r`: resume. `s`: stop, followed by `y` or `n` to avoid an accidental keypress stopping the company.
- `f`: refresh. `q` or Ctrl+C: close the interface.
- CEO chat: type a message; Enter saves it, Ctrl+U clears the draft, Escape returns to overview. Up/down scroll the conversation.

Terminal output strips control characters and ANSI sequences from model and repository text.

## API

Versioned routes live under `/api/v1`; `/api/v1/openapi.json` is the route contract. Owner API requests use a local Bearer token or authenticated same-origin WebUI session. Worker credentials never authorize Owner routes. CLI/TUI service discovery survives port reassignment. The UI stays disconnected until it can obtain real state; it never invents employees or activity.
