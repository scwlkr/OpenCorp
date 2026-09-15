# Research: the smallest effective environment for a local builder

Research date: 2026-09-15. Supports [Research the smallest effective environment for a local builder](https://github.com/scwlkr/OpenCorp/issues/49), within [Reinvent OpenCorp through Levels of Proof](https://github.com/scwlkr/OpenCorp/issues/47).

## Finding

There are credible existing runtimes to test before writing another agent loop. Start with **direct OpenCode and Pi** as a small, contrasting pair. Keep **Hermes** as the next candidate for integrated browser, memory and continuity; treat **OpenClaw** as another platform candidate, not a prerequisite. This is an experimental recommendation, not a runtime selection or proof that any model can build independently.

The unit being qualified is **model weights/quantization + inference server + agent runtime/version + enabled tools + instructions + context settings + execution environment**. An inference server generates responses; an agent runtime interprets tool calls and continues after tool results. An organization chart adds neither capability automatically.

This investigation read primary documentation only. No runtime was installed, configured or executed; no model was downloaded or tested. Documentation establishes supported interfaces, not successful operation on the Owner's machine. Pin actual versions and read matching documentation before trials: OpenCode currently exposes both [ordinary provider documentation](https://opencode.ai/docs/providers/) and [v2 provider documentation](https://opencode.ai/v2/docs/providers) with different configuration shapes; this research uses the current [Pi repository](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).

## Candidate comparison

### OpenCode: focused coding runtime

- **Local/hosted engines:** documents local models and custom provider endpoints. Ollama's integration guide recommends at least 64K context for OpenCode. That recommendation is a starting constraint to test, not proof that more context improves results or fits the machine. [Providers](https://opencode.ai/docs/providers/), [Ollama integration](https://docs.ollama.com/integrations/opencode).
- **Tools:** built-in shell, file reading/writing/editing/search and web fetch; extensions and MCP can add capabilities. A web fetch is not interactive browser inspection. Supply a documented browser CLI or MCP only when the task requires one. [Tools](https://opencode.ai/docs/tools/).
- **Context/continuity:** supports instruction files, configurable compaction, on-demand skills, continuing sessions and exporting sessions. These provide useful components without requiring OpenCorp's company workflow. [Configuration](https://opencode.ai/docs/config/), [Skills](https://opencode.ai/docs/skills/), [CLI](https://opencode.ai/docs/cli/).
- **Boundary/observation:** allow/ask/deny permissions are available; CLI JSON events and exports can expose actions and failures. Permission rules are not evidence of OS isolation. Test the actual shell boundary separately. [Permissions](https://opencode.ai/docs/permissions/), [CLI](https://opencode.ai/docs/cli/).
- **Unproven:** exact local tool schema compatibility, reliable debugging, compaction quality, browser success and independent delivery. Test direct OpenCode before concluding the existing OpenCorp integration is necessary or sound.

### Pi: minimal contrast

- **Tools/continuity:** four default tools—read, write, edit and bash—plus skills/extensions. Sessions auto-save as JSONL, can resume and branch, and offer automatic/manual compaction. JSON event mode exposes execution. Its documentation explicitly describes compaction as lossy. No built-in browser or MCP is promised by the minimal core; browser work can use an equipped CLI. [Coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).
- **Local/hosted engines:** custom models support compatible local servers, including Ollama, with API compatibility options. Context limits and protocol settings must match reality; registering a model does not qualify its tool behavior. [Custom models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md).
- **Boundary:** the core deliberately omits permission popups and recommends containers or extensions for that need. Run it in a deliberately bounded environment, not the Owner's unrestricted shell. [Coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).
- **Unproven:** whether the smaller tool surface helps a particular local model, how much equipment must be added, and whether model switching preserves usable task context. Its simplicity makes it a diagnostic comparator, not an automatic winner.

### Hermes: integrated agent platform that can start smaller

- **Local engines:** documents managed llama.cpp models and separately configurable model providers. Managed model setup may choose memory/context settings automatically; use an explicitly controlled inference setup when comparing identical model settings across runtimes. [Local models](https://hermes-agent.nousresearch.com/docs/user-guide/local-models), [Configuring models](https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models).
- **Equipping the agent:** Blank Slate setup enables only model/provider, files and terminal. It also disables skills, memory, compression and other features. It therefore needs deliberate additions for a fair equipped-builder trial; minimal installation alone is not the agreed environment. [Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart).
- **Tools/boundary:** local terminal is explicitly unisolated; container and other terminal backends exist. Local browser operation is documented, but browser execution is a separate surface: do not assume terminal sandbox settings cover it. Avoid real-profile browser access in initial trials. [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration), [Browser](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser).
- **Continuity:** persistent memory, resumable sessions and context compression are documented. These are candidate mechanisms to test for retained requirements and correct recovery, not proof of autonomous learning. [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions), [Compression](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching).
- **Unproven:** local-model quality across the broader toolset, hidden auxiliary-model routes, browser reachability into a sandbox, and reliable restart. Default hosted onboarding is not an authorized route for a $0 local-only proof.

### OpenClaw: capable platform, additional surface to control

- **Local engines:** its Ollama integration explicitly uses native `/api/chat`, warning against the `/v1` route for tool calling. It documents local-only mode separately from cloud modes. A URL that is valid for another runtime is not automatically valid here. [Ollama](https://docs.openclaw.ai/providers/ollama).
- **Tools/context:** documents local model configurations, managed browser control, memory and sessions. Its local-model guide warns that loading a model or answering a short prompt does not establish that a full agent turn works. [Local models](https://docs.openclaw.ai/gateway/local-models), [Browser](https://docs.openclaw.ai/tools/browser), [Memory](https://docs.openclaw.ai/concepts/memory), [Sessions](https://docs.openclaw.ai/concepts/session).
- **Boundary/observation:** sandboxing is off by default; the gateway remains on the host when tools are sandboxed. Effective policy can be inspected with `sandbox explain`. Elevated execution is a separate escape hatch. Verify the main session is sandboxed rather than copying a non-main-only example. [Sandboxing](https://docs.openclaw.ai/gateway/sandboxing).
- **Unproven:** whether platform features improve useful output enough to justify their configuration and context costs. Retain as a candidate if initial runtimes fail for a concrete environmental reason, or later continuity/messaging experiments need its facilities.

## Proposed smallest fair experiment

These are recommendations for the human decision ticket; no experiment was run.

1. **Separate setup from evaluation.** Provision a disposable project, bounded execution environment, language/package tools, reference documentation, working local browser access when needed, and a short reusable operating guide. Verify those tools work without inference first. Record equipment failures separately from reasoning failures.
2. **Avoid a Cartesian-product research swamp.** Start with one hardware-appropriate model and two runtimes. Resolve basic protocol failures, then hold one credible runtime fixed while screening model candidates sequentially. Revisit runtime choice for concrete failure modes or finalist comparison. Do not download every combination at once.
3. **Use matched starting conditions.** Same brief, acceptance behavior, tool capabilities, model settings, available resources and time budget. Each attempt starts with fresh state. Keep useful manuals and skills; do not give the solution or inherit a previous candidate's task-specific fixes.
4. **Start with a tiny useful app.** For example, import a synthetic CSV, validate malformed rows, filter/search it and export selected results. Require running behavior and independently checked outputs. The particular product is replaceable; it should exercise files, execution, iteration and user-facing behavior. Add browser inspection for a browser app. A hosted deployment is a separate proof with a real authorized destination; localhost does not establish public release.
5. **Capture only decisive evidence.** Configuration/version, starting brief, tool calls/results, final artifact, independent acceptance result, elapsed time, memory pressure, and human interventions. Record whether failure was invalid tool syntax, wrong tool choice, environment restriction, context loss, implementation error, false completion or exhausted time. Do not build a custom evaluation platform first.
6. **Tune, then retest fresh work.** Allow a declared bounded tuning round, distinguish initial/tuned results, and retest finalists on unfamiliar tasks plus a requested feature change. Add stop/resume and forced context pressure only after basic building works. Preserve exact interventions; equipping the next run is valid, rescuing the current run is assistance.
7. **Stop at a useful conclusion.** If no candidate clears the agreed small-builder gate within the research budget, halt company expansion. Report which combinations failed and why. Failure of the tested set means no demonstrated viable setup yet, not mathematical proof that local building is universally impossible.

## Engine swapping and local-only integrity

Model selection is not capability equivalence. Before any swap, preserve files and a concise task state; verify the replacement accepts the actual tools, fits remaining context, understands prior actions, and can resume without repeating external effects. Test swaps at a clean boundary first, then mid-task. A session record surviving does not prove processes, browser state or understanding survive.

For local-only trials, account for **every** model call: main agent, compaction, memory, title generation, image analysis, browser helper and fallback. Do not infer local-only operation from a local primary-model label. No hosted helper may quietly make a local candidate pass. Later OpenRouter trials require separately verified free routes and fail-closed spending controls; provider support in these runtimes does not establish those controls. Never configure paid fallback for this effort.

## Handoff checkpoint

2026-09-15 15:31 local: documentation-only research prepared for a single-file commit in a fresh clone of public `origin/main`; no private runtime records or configuration included. Full staged content reviewed; diff whitespace check and staged Gitleaks scan passed. Publication and tracker resolution belong to the parent session; no runtime choice or implementation decision is closed by this asset.
