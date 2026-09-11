# OpenCorp — General Technical Direction

## Purpose

OpenCorp is a persistent autonomous AI corporation harness.

It should feel like Claude Code reimagined as a company: instead of one general-purpose agent handling one task at a time, OpenCorp operates through persistent employees, managers, departments, projects, and executive leadership.

The technical goal is not to invent a new agent ecosystem. OpenCorp should reuse proven patterns wherever possible and reserve novel engineering for the corporate operating layer itself.

---

## Core Technical Principles

### 1. Standards First

OpenCorp should never reinvent solved infrastructure when a proven standard, protocol, runtime pattern, SDK, or storage approach already exists.

Existing agent-runtime patterns should be reused for:

- agent loops
- sessions
- tool calling
- permissions
- context management
- model invocation
- subagents
- MCP
- filesystem access
- shell execution
- Git
- browser and computer-use tools

Novel engineering should focus on the corporate abstraction.

### 2. Outcome Over Proof

OpenCorp should not become a testing, evaluation, tracing, or proof-capture factory.

The system should prioritize real work and real outcomes. Managers and employees should inspect results, judge quality, and make organizational decisions from those outcomes.

Programmatic proof generation should never become the core operating philosophy.

### 3. Corporate Intelligence Is the Invention

The differentiated layer is:

- persistent employees
- organizational hierarchy
- departments
- projects
- delegation
- management
- specialization
- hiring and firing
- promotions and reassignment
- performance judgment
- institutional memory
- autonomous project creation
- organizational evolution

Everything beneath that should be as conventional as practical.

---

## System Architecture

```text
CLI / TUI / WebUI / API
          │
          ▼
┌──────────────────────────────┐
│        OpenCorp Core         │
│                              │
│ Corporate hierarchy          │
│ Employees and departments    │
│ Projects and delegation      │
│ Hiring / firing / promotion  │
│ Scheduling and concurrency   │
│ Performance judgment         │
│ Organizational memory        │
│ Autonomous company behavior  │
├──────────────────────────────┤
│      Standard Agent Runtime  │
│                              │
│ Agent loops                  │
│ Context management           │
│ Sessions                     │
│ Tool calls                   │
│ Permissions                  │
│ Escalation                   │
├──────────────────────────────┤
│     Tool / Execution Layer   │
│                              │
│ Shell                        │
│ Filesystem                   │
│ Git                          │
│ Browser / computer use       │
│ APIs                         │
│ MCP                          │
├──────────────────────────────┤
│       Model Router           │
└──────────┬──────────┬────────┘
           │          │
        Local Ollama pool
        (no hosted fallback)
```

---

## Interfaces

OpenCorp should expose one shared backend through multiple interfaces:

- CLI
- API
- TUI
- WebUI

The interfaces should not contain the company logic. They are control surfaces for the same persistent OpenCorp runtime.

WebUI is the primary daily Owner experience. CLI remains scriptable and composable; CLI, API, TUI and WebUI all ship against one authenticated loopback backend.

---

## Corporate Runtime

The corporate runtime is the heart of OpenCorp.

It is responsible for:

- maintaining the company hierarchy
- assigning work
- creating and managing projects
- delegating through management
- activating employees
- coordinating departments
- running multiple projects simultaneously
- controlling concurrency
- escalating difficult work
- changing model capability when needed
- hiring, firing, promoting, and reassigning employees
- restructuring teams when outcomes are poor
- allowing leadership to originate new projects

OpenCorp should operate as a persistent long-running company service rather than a temporary interactive session.

---

## Model Connectivity

Employees should remain provider-agnostic.

The first release uses only local Ollama on the Owner's Mac, with cloud features disabled and no hosted fallback, including background model calls. OpenCode 1.18.30 owns the agent loop under OpenCorp scheduling and native process-tree isolation. The matching SDK, tool adapters and per-run credential broker run independently of a builder session. Model-weight training and cloud adapters are outside this release.

An employee is not a model. Models are replaceable cognitive engines assigned to persistent employees.

---

## Model Hierarchy

OpenCorp should use specialization to reduce dependence on frontier models.

Typical behavior:

- workers use smaller or local models for narrow specialized tasks
- managers use stronger models for coordination, review, and decomposition
- executives use stronger models for strategy and synthesis
- difficult work receives a stronger local model without requiring promotion; management handles organizational escalation
- multiple smaller workers may operate concurrently

Model capability follows task complexity independently of employee identity or position. Begin with one active inference request; increase to at most two only after qualifying memory use, keeping large models mutually exclusive initially.

---

## Tool and Execution Layer

OpenCorp should follow established agent-harness patterns.

Primary execution capabilities should include:

- shell
- filesystem
- Git
- browser
- computer use
- external APIs
- MCP
- permissions
- mandatory native process-tree restrictions around each worker runtime and descendants

MCP should be treated as the primary standard for connecting external tools when suitable.

---

## Persistence and Memory

OpenCorp should use a hybrid persistence model.

### Obsidian-Compatible Markdown

Human-readable institutional knowledge should live in a Markdown vault.

Examples:

```text
/company/
/departments/
/projects/
/employees/
```

Employee folders use collision-resistant internal IDs; badges are presentation labels, such as:

```text
/employees/1234-5678/
```

Possible employee records:

```text
profile.md
role.md
memory.md
performance.md
relationships.md
```

Project knowledge should likewise remain organized and readable inside the vault.

### SQLite

Structured operational state should use SQLite where querying and consistency matter.

Examples:

- employee IDs
- employment status
- reporting relationships
- permissions
- project state
- task queues
- assignments
- model configuration
- resource limits
- organizational structure

### JSONL

Bounded, rotated, redacted runtime history may use append-oriented JSONL. SQLite is the single authority for operational state and queues; JSONL is not another queue.

Examples:

- conversations
- tool events
- agent activity
- historical execution records

Markdown should remain the durable human-readable knowledge layer, while structured state should use formats suited to structured state.

---

## Persistent Company Model

OpenCorp is not a session.

The company persists across:

- terminal sessions
- application restarts
- model changes
- employee model upgrades
- project transitions

Persistent entities include:

- employees
- departments
- leadership
- projects
- relationships
- responsibilities
- company knowledge
- performance history
- organizational state

The interfaces may close. The company remains.

---

## Final Technical Principle

OpenCorp should not compete with Claude Code or Codex by rebuilding their solved agent infrastructure.

It should adopt proven agent-harness conventions and place a persistent corporate operating system above them.

The model is replaceable.

The employee persists.

The organization compounds.


## Selected First Release
`OpenCorp_Build_Plan.md` settles the implementation: Node 24.20.0, TypeScript modular monolith, Hono/Zod/OpenAPI/SSE, SQLite WAL through better-sqlite3, React/Vite WebUI, Commander CLI, Ink TUI and a user LaunchAgent. Operational state owns lifecycle, identity, appointments and authority; Markdown owns narrative knowledge with FTS5 retrieval, source links, corrections and preserved human edits. Vault edits cannot grant authority. Backup pairs a consistent database with a matching vault snapshot, and restore reconciles external actions without blindly repeating them.

Products endure above finite projects. Three Elders govern executives through independent initial judgments and two-of-three votes; daily reporting is separate. Home managers retain employment authority while project supervisors direct accepted work. Role seeds are versioned competencies, not identity or authority.

Initial autonomy covers the three registered products, implementation, reviews, exact-commit merges, confirmed zero-cost releases, connected product communications and subsequent work. New spending requires scoped Owner approval, with an unapproved allowance of $0. Sleep settings are untouched. Closing interfaces leaves the company running; explicit pause and stop persist across restart. Idle employees consume no inference, and sleeping hardware performs no work.
