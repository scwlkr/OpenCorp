# Useful small-model work

Use small models for bounded work that helps an actual recipient: extracting supplied facts, drafting a short operator explanation or making a focused correction. Inspect the result. Expand an employee's assignments through useful success, and change engines through `employee.model` when needed. Keep the employee while changing its engine. Identity, approved skill and retained work persist. Specialize through the skill and relevant context first; weight fine-tuning needs an evidence-based proposal within existing resource and spending authority.

## Candidate configuration

Consider these candidates without treating them as installed, qualified or fixed worker classes:

| Candidate | Selection |
| --- | --- |
| Granite 4.0 H-350M | Configure a locally imported, inspected artifact. |
| Qwen3-0.6B | Existing `micro-06` / `qwen3:0.6b` mapping. |
| LFM2-700M | Configure a locally imported, inspected artifact. |
| Llama 3.2 1B Instruct | Configure the exact installed instruction-tuned artifact. |
| Granite 4.0 H-1B | Configure a locally imported, inspected artifact. |

The operator may put additional mappings in `local-models.json` in the company data directory, then restart the service and refresh model inventory. Keys are unique `micro-` IDs; values are local `name:tag` aliases. For example, after separately importing and inspecting those exact local aliases:

```json
{
  "micro-granite-h350": "granite-h350:local",
  "micro-lfm2-700": "lfm2-700:local",
  "micro-llama32-1b": "llama32-1b-instruct:local",
  "micro-granite-h1b": "granite-h1b:local"
}
```

These are illustrative local names, not download IDs. Inventory only imports artifacts already in the configured source model store; it never downloads these candidates. Built-in aliases cannot be overwritten. Cloud-backed manifests are refused. A `micro-` ID selects the small-worker service, not social permissions or a Qwen-specific inference profile. Actual model metadata determines tool availability. Runtime embedders may supply the same mapping as `RuntimeOptions.localModelAliases`.

## Capacity and retained companies

Use the existing Owner `policy.update` command to set `maxInference`, `maxProductiveTurns` and optional `maxLoadedModels`. `maxProductiveTurns` is the Owner-configured maximum number of simultaneous productive employee runs, bounded by `maxInference`; it is a capacity limit, not proof that concurrent work is useful. All default conservatively; productive capacity cannot exceed total slots. Employees cannot raise these controls. Different installed local profiles can share capacity without a fixed strong/small pairing or model-authored qualification form. The scheduler still prevents overlapping work by the same employee or in the same project. Social runs retain separate permission and capacity restrictions.

Retained limits, provider caps, identities, permissions and work are preserved on upgrade. Historical local qualification records remain historical evidence; they no longer pin local work to one model. Explicit retained mixed-provider profiles still constrain that configuration. An Owner may clear an obsolete mixed configuration with `productiveConcurrencyQualification: null` and choose local capacity; this does not enable any hosted model. Remote eligibility, account limits, cooldowns and data restrictions still apply.

Ollama preallocates context for its configured parallel slots. Both services use configurable residency, and small workers can use productive capacity even when social capacity is one. Admission charges all parallel contexts before the first request, retains shared allocations until the last run releases, observes host memory/pressure and preserves headroom. Known dense attention layouts use artifact layer/head dimensions; unknown and hybrid layouts use a conservative fallback, raised by observed residency when needed. Estimates are guards, not exact memory measurements or workload qualification. See [Ollama concurrency and memory guidance](https://docs.ollama.com/faq).

For supplied-text conversations, `/api/v1/chat` accepts `textOnly: true` alongside `employeeId` and `content`. It supplies the approved employee skill and complete request without the company summary or tool schemas, and disables both native and corporate tools. Use this only when the supplied material is sufficient; normal conversations retain tools for inspection and action. Management-created conversation assignments can use `payload.textOnly: true`. This reduces capabilities and context; it never permits a prose-only implementation or bypasses delivery checks.

## Choose the useful level

Compare ordinary assignments at conservative serial and concurrent settings. Record elapsed turnaround, useful results accepted, corrections and coordination time in existing run notes or management knowledge. Include cold-start costs and identify differing tasks; do not claim a controlled speedup from unlike work. Inspect recent run context and actions through [existing run inspection](RUN_INSPECTION.md). Reduce concurrency when memory pressure, latency or rework worsens. Keep only relevant instructions and source excerpts; a large context window is not a reason to fill it.

A completed inference is not necessarily useful work. Keep the useful result and lessons, not a benchmark platform, fixed swarm target or automatic promotion score.

## Observed operation, September 13, 2026

Two persistent employees used installed Qwen3 models to draft this operator guidance through the shared service. Normal 0.6B turns carried about 15,000 input tokens and included unusable or incomplete answers. Explicit supplied-text turns reduced input to approximately 400–535 tokens. Switching the same employees to 1.7B and then 4B preserved their records; neither engine's completion status alone established accuracy. Several drafts required correction, including fabricated source wording and irrelevant acknowledgment advice.

After reviewing and narrowing the work, two 4B productive runs overlapped with social capacity set to one. The pair took 6.4 seconds and produced the capacity definition and employee-continuity sentence incorporated above. The latter needed quotation marks removed because it was a paraphrase, not a verbatim excerpt. A serial pair of different accepted operator answers took 8.9 seconds. Five observed batches totaled 18 turns and 132 seconds of batch time; review/edit time was not instrumented. These unlike tasks, earlier retries and uninstrumented review/edit time do not establish a useful speedup; retain a conservative setting and compare further during actual work. Two simultaneous small-model runs were observed, not a larger qualified swarm. Host memory pressure remained normal. No model download, paid inference or installed-company capacity increase was required.
