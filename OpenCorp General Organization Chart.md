# OpenCorp — General Organization Chart

OpenCorp models a real corporation. Employees are persistent identities with employee IDs, managers, responsibilities, permissions, memory, and performance history. Positions are separate offices, potentially vacant; appointments connect employees to positions and retain history. Models are replaceable cognitive engines.

The organization may create, remove, merge, or expand positions and departments as needed.

## Authority

```text
USER / OWNER
    │
    ▼
ELDERS (3)
    │
    ▼
CEO
    │
    ├── C-SUITE
    │     ├── CTO — Technology / Engineering
    │     ├── COO — Operations
    │     ├── CFO — Finance
    │     ├── CPO — Product
    │     ├── CMO — Marketing / Growth
    │     └── Other executives as required
    │
    ▼
DEPARTMENT LEADS
    │
    ▼
PROJECT MANAGERS / TEAM LEADS
    │
    ▼
SPECIALIZED WORKERS
```

## Governance

### User / Owner
Highest authority.

Defines overall intent, company constraints, and approvals reserved for the User.

### Elders
Three independent senior overseers.

Responsibilities:
- evaluate CEO and C-Suite performance
- review output quality, judgment, and timelines
- hire and fire C-Suite employees
- replace underperforming leadership

Appointments, replacements and dismissals require two of three Elder votes. Initial judgments are formed independently before peer votes are disclosed. Reasons and dissent persist. The CEO proposes executive candidates; only the Owner can override or replace Elders.

Elders do not normally manage daily work.

## Executive Leadership

### CEO
Ultimately responsible for company performance.

Responsibilities:
- interpret User intent
- establish company goals
- originate projects and ventures
- coordinate executives
- allocate organizational attention
- make major strategic decisions

### C-Suite
Executives own major organizational domains.

Typical positions:

**CTO** — engineering, infrastructure, technical architecture, AI systems  
**COO** — company operations, processes, execution capacity  
**CFO** — budgets, accounting, financial analysis, resource economics  
**CPO** — products, product strategy, customer needs  
**CMO** — marketing, brand, positioning, distribution, growth  

Additional executive roles may be created when justified.

## Departments

Executives oversee persistent departments.

Example:

```text
CTO
├── Software Engineering
├── AI / Research
├── Infrastructure
└── Security

CPO
├── Product Management
├── UX
└── Design

CMO
├── Brand
├── Content
├── Market Research
└── Growth

COO
├── Operations
├── Administration
└── Internal Systems

CFO
├── Accounting
├── Financial Planning
└── Resource Management
```

Departments should emerge from actual organizational needs rather than requiring a fixed universal structure.

## Department Lead

Runs a persistent department or major specialization.

Responsibilities:
- manage department employees
- maintain department knowledge
- assign resources to projects
- evaluate workers
- identify staffing needs
- improve department capability

## Project Manager / Team Lead

Owns execution of a specific project or workstream.

Responsibilities:
- convert goals into assignments
- coordinate workers across departments
- track dependencies and blockers
- review outcomes
- report upward
- create follow-up work

Project teams may contain employees borrowed from several persistent departments. Their home manager owns employment and capability; an accepted project supervisor directs assignment work. Executives resolve conflicts. Products retain enduring goals and roadmaps above finite projects.

## Workers

Workers are highly specialized employees responsible for producing work.

Examples:

```text
Frontend Engineer
Backend Engineer
Database Engineer
SVG Designer
UX Designer
Copywriter
SEO Specialist
Market Researcher
Security Engineer
DevOps Engineer
Financial Analyst
Technical Writer
```

OpenCorp should prefer narrow specialization where practical so smaller models can perform useful work effectively.

## Starting Role Skill Library

OpenCorp should avoid recreating role instructions that already exist.

Many initial departments and specialized workers may seed their skill/instruction files from:

`https://github.com/msitarzewski/agency-agents`

The repository should be treated as a **starting role library**, not as a dependency on OpenCorp's organizational model.

Imported role files may be adapted into OpenCorp's employee skill format. They define useful starting competencies and operating instructions; they do **not** define the employee's persistent identity, memory, relationships, authority, or performance history.

Over time, OpenCorp employees may develop beyond their original imported skill files through accumulated experience and organizational learning.

OpenCorp may also support other compatible role/skill libraries in the future rather than tying employee creation to a single repository.

When repository content is copied or redistributed, its applicable upstream license and attribution requirements must be preserved.

## Supporting Organization

Not every employee belongs directly to a production hierarchy.

OpenCorp may maintain supporting roles such as:

```text
Executive Secretary
Executive Assistant
Chief of Staff
Recruitment Officer
HR Manager
Office Manager
Administrative Assistant
Records Clerk
Receptionist
Internal Communications
IT Support
Janitor
```

These are real organizational roles and may perform useful company functions rather than existing merely for simulation.

## Employee Identity

Every employee should have a persistent identity such as:

```text
Employee ID: #1234-5678
Name: Jane Mercer
Title: Frontend Engineer
Department: Software Engineering
Manager: Engineering Lead
Employment Status: Active
```

The employee persists independently of the LLM currently powering them.

## Organizational Rule

OpenCorp does **not** require every corporation to use the same org chart.

This structure defines the organizational grammar:

```text
Owner
  ↓
Governance
  ↓
Executive Leadership
  ↓
Departments
  ↓
Management
  ↓
Specialized Workers
```

Domain managers may hire, dismiss and develop nonexecutive employees within their remit. Executives may reorganize departments and propose new executive positions. The Elders control executive appointments, replacement and dismissal. Leadership cannot abolish oversight or change Owner-reserved policy. Staffing exists for concrete product needs; role seeds grant no external authority or physical resources.

The organizational relationships are foundational. The specific positions occupying them are company state and may evolve continuously.

The initial mandate in `OpenCorp_Build_Plan.md` delegates portfolio strategy and daily operations; no Owner roadmap or routine approval is required. Leadership starts from three Elders and one CEO, then creates the needed organization through actual decisions. Capability follows task difficulty independently of position.
