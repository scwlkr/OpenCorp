# OpenCorp

A persistent software factory company that creates and maintains products people and agents actually use. A large specialized workforce reasons through concise Markdown skills, learns quickly and uses available local and free hosted inference. Code supplies the necessary tools and controls.

- [Company charter](COMPANY.md): mission, organization, operations and Owner relationship.
- [Implementation plan](https://github.com/scwlkr/OpenCorp/issues/1): complete target, existing foundations, gaps and completion conditions.
- [Build specification #1](https://github.com/scwlkr/OpenCorp/issues/1): user stories, implementation decisions and the agreed validation approach.
- [AGENTS.md](AGENTS.md): repository engineering rules.
- [Glossary](CONTEXT.md): company language.
- [Run inspection](docs/RUN_INSPECTION.md): inspect employee context, tools and outcomes.
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE).

## Implementation status

The source includes persistent company state, OpenCode/MCP execution, local and free-provider adapters, role revisions, repository tools and limited delivery/adoption paths. The full charter is not implemented. Telegram/email, Low power, scoped paid-inference budgets, Markdown-authoritative skills and general product delivery require work. Existing company state still needs migration from earlier mandates.

Fresh bootstrap still targets `~/Desktop/dev/WalkLang`, `~/Desktop/dev/paletteWOW`, and `~/Desktop/dev/openjob`. Its founding mandate authorizes autonomous reviewed merges, qualified releases and product communications. Review the bootstrap configuration and connected identities before starting a new company; existing databases retain their recorded configuration.

## Existing controls

```sh
opencorp status
opencorp chat 'What useful work has shipped, and what is blocked?'
opencorp pause
opencorp resume
opencorp stop
opencorp start
opencorp doctor --json
```

Current pause interrupts active work and preserves it; it is not the planned Low power mode. Stop also stops owned runtimes. Existing local inspection surfaces remain available through `opencorp open`, `opencorp tui` and the authenticated API. The default WebUI is http://127.0.0.1:4310; `opencorp open` handles authentication and discovered ports. Telegram/email are the intended Owner interfaces.

## Development and installation

The existing implementation targets Apple Silicon macOS and Node 24.20.0. Its local runtime uses Ollama; product-specific tools and connected identities depend on the work being performed. Check [runtime](docs/RUNTIME.md) and [connected tools](docs/CONNECTED.md) for actual restrictions.

```sh
mise trust
mise exec node@24.20.0 -- npm ci
mise exec node@24.20.0 -- npm run verify
```

For a reviewed installation, see [service operations](docs/SERVICE.md). Installing the current source does not implement the new charter. The service can operate independently of terminals and browsers.

Operational state defaults to `~/.local/share/opencorp/company.sqlite`; readable knowledge is in `vault/` and isolated work in `workspaces/`. Credentials remain private. Backups and restore preserve recovery information; use the documented controls before changing a running installation.

## Technical references

[Domain](docs/DOMAIN.md) · [Interfaces](docs/INTERFACES.md) · [Free inference](docs/FREE_INFERENCE_POOL.md) · [Delivery](docs/DELIVERY.md) · [Releases](docs/RELEASES.md) · [Verification](docs/VERIFICATION.md)

The unapproved spending budget remains $0.

Vendored [Agency Agents](https://github.com/msitarzewski/agency-agents) skills retain their [license](skills/vendor/agency-agents/LICENSE) and [provenance](skills/vendor/agency-agents/provenance.json). Dependencies and model artifacts retain their respective licenses.
