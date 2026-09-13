# Employee runtime

This reference describes the implementation, not the full company ambition. [Company direction](../COMPANY.md) and the [implementation plan](https://github.com/scwlkr/OpenCorp/issues/1) govern its evolution.

`LocalRuntime` in `src/runtime/index.ts` supervises pinned OpenCode through its SDK. OpenCode owns the conversation, tool loop and compaction; OpenCorp supplies employee identity, assignment, workspace, instructions, selected model and scoped MCP access. The runtime binds the native session before employee effects. Employees retain identity without an idle process.

## Inference and resources

Owned Ollama processes use private model stores and loopback gateways. Resource admission checks configured capacity and host memory; primary and micro model pools have separate controls. Local profiles retain model identity and context configuration. Hosted inference also exists through explicitly permitted direct providers and the [free inference pool](FREE_INFERENCE_POOL.md). Provider availability and account eligibility must be checked on the actual installation. This is not a local-only runtime, nor unrestricted hosted access.

The scheduler selects bounded contexts and run deadlines. The runtime counts requests, tool steps and output continuations; a model stopping at its limit is not assignment completion. Runtime results retain actual model, usage, response and failure information. Compaction and continuation remain inside the original run budget. Check `src/runtime/index.ts` and `src/scheduler/scheduler.ts` for current values rather than copying them into operational instructions.

Full-power/low-power/stop as an integrated operating model is planned. Existing pause/stop and pool limits are useful foundations; micro models do not establish that useful background company work is qualified.

## Native boundary and recovery

The OpenCode process tree runs under the pinned macOS sandbox runtime. Workers receive a constructed environment, an owned HOME and their workspace, with read-only toolchain access. Owner credentials, company-control files and unrelated workspaces stay outside their access. Trusted brokers handle credentialed repository/provider operations. The gateway admits only assigned inference and scoped corporate tools; worker tokens never grant Owner API access.

Owned native jobs record launch intent and process identity. A guardian and coalition-aware helper handle cancellation and orphan cleanup. `recoverRun` distinguishes absent, running and uncertain ownership; `recoverTools` also reconciles native work such as dependency installation. Unknown identity is not permission to signal an unrelated process or replay an external action. Cancellation closes effect gateways before terminating owned work.

`executeSandboxed` shares this boundary with repository checks. Trusted dependency adapters can provide restricted toolchain access and local-test networking; employee arguments cannot grant arbitrary environment or filesystem access. Local-test forwarding checks that destination listeners belong to the worker coalition. These protections are executable requirements, not employee etiquette.

## Integration

`LocalRuntime` exposes `start`, `models`, `execute`, `cancel` and `stop`. Execution accepts durable run/employee identity, workspace, model, system/prompt, scoped broker, session/event callbacks and cancellation signal. Results contain actual session/model identity, text, usage and retained diagnostics. See exported types in source for optional provider and resource arguments.

`src/tools/dependencies.ts` prepares supported product dependencies in owned workspaces using restricted downloads, checksums and sandboxed installation. Existing product adapters are implementation-specific; they are not a universal build platform. `tests/runtime.test.ts` and `scripts/verify-local-runtime.ts` exercise different layers of this integration. See [verification](VERIFICATION.md).
