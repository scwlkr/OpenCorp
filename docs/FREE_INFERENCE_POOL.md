# Free inference pool

OpenCorp exposes `free-pool` as a logical routed model through `FreeInferencePool.generate(request)`, alongside existing local and direct-provider selections.
The existing authenticated employee gateway calls it; the authenticated Owner endpoint is
`POST /api/v1/inference/chat/completions` with `model: "free-pool"`.
Enable `freeInferencePool: true` through the Owner `policy.update` command, then assign
`free-pool` through `employee.model`. Local employees and their memory limits stay local.
Actual serving model IDs appear in responses and `runtime.inference.routed` events.

```json
{
  "model": "free-pool",
  "messages": [{"role": "user", "content": "Summarize this public release note."}],
  "quality": 1,
  "dataClass": "public",
  "max_tokens": 256
}
```

Quality 1 is lightweight work, 2 general/tool work, 3 demanding work. Quality labels
are configuration judgments, not benchmark claims. The router filters context size,
tools, forced-tool compatibility, JSON output and data/use restrictions before ranking.
It prefers the smallest sufficient quality, recurring allowances, then remaining local
budget. Unsupported requests are refused; prompts are never silently truncated.
Confidential requests are rejected by this remote pool. Images are not supported.

## Failure and renewal behavior

- At most four attempts, never retrying the same provider/model in a generate call;
  45 seconds per attempt, 120 seconds overall. Adapters have no inference retry loops.
  Model-specific failures can try another model; account holds skip all its models.
- SQLite atomically reserves account concurrency and estimated request/token budgets
  before network I/O. All models share account holds. API key rotation adds no quota.
- HTTP 429/402, outages, malformed replies and transport failures fall back before any
  output reaches the employee. Retry-After is honored. Daily quota errors use documented
  UTC/OpenRouter or Pacific/Gemini reset boundaries. Otherwise exponential backoff with
  jitter is explicitly an estimate. Successful Groq zero-remaining headers tighten holds.
- Quotas configured as rolling periods renew automatically on the next request. A zero
  period is a non-renewing trial. Expired leases recover after crashes. Authentication
  failures wait for a configuration revision/restart, rather than retrying forever.
- No automatic renewal of account eligibility evidence or expired trials. Quota reset
  is different from permission to bill. Existing key-bound direct-provider audits keep
  their existing expiry; refresh those account checks deliberately.
- Stream output is buffered and validated before delivery, then emitted as compatible
  SSE. This trades first-token latency for safe failover with complete tool arguments.
  Function tools execute only in the employee's existing broker, never in the router.
- Local counters are conservative estimates including failed attempts, not account
  balances. Calls made outside OpenCorp can consume additional capacity. Provider limits
  remain authoritative. When no candidate fits, return 429 and Retry-After; no paid route.

This pool is implemented; provider registration does not establish current account eligibility or successful employee workload qualification. It provides no approved paid-project budget. See [COMPANY.md](../COMPANY.md) and the [implementation plan](https://github.com/scwlkr/OpenCorp/issues/1) for the broader routing and spending direction.

## Providers and account setup

The Providers page includes the pool registry and local budget state. The same data is
available at `GET /api/v1/inference/providers`. Registry presence does not mean a key,
free tier or model qualification is available.

The table lists implemented eligibility assumptions and official references, not a fresh verification of provider offers. Recheck terms and account evidence before enabling a route.

| Provider | Free access and guard |
| --- | --- |
| [Gemini](https://ai.google.dev/gemini-api/docs/pricing) | Existing audited free project; model/project quota and Pacific daily reset. Free-tier data terms apply. |
| [Groq](https://console.groq.com/docs/rate-limits) | Existing audited free account; request and token caps differ. Large contexts may not fit its minute allowance. |
| [OpenRouter](https://openrouter.ai/docs/api_reference/limits) | Existing zero-spend key; freshly checked zero model AND endpoint prices. Free models share account limits. |
| [Z.ai](https://docs.z.ai/guides/overview/pricing) | Existing audited exact free Flash selection, auto tool choice, one stream. |
| [NVIDIA NIM](https://docs.api.nvidia.com/nim/docs/product) | Developer evaluation access only; public evaluation requests, not ordinary company work. |
| [Cerebras](https://inference-docs.cerebras.ai/support/rate-limits) | Account/trial-dependent. Do not assume a renewing free tier or enable paid conversion. |
| [Mistral](https://docs.mistral.ai/admin/billing-usage/subscriptions) | Free mode with account/model-dependent limits; verify account before enabling. |
| [Hugging Face](https://huggingface.co/docs/inference-providers/pricing) | Small monthly routed credits; no paid credits, custom provider key, or postpaid billing. |
| [Cloudflare](https://developers.cloudflare.com/workers-ai/platform/pricing/) | Free-plan daily neuron allowance; keep Workers on Free so exhaustion stops requests. Tokens are not neurons. |
| [Cohere](https://docs.cohere.com/docs/rate-limits) | Trial/evaluation keys are not production keys; separate from Cohere models served by OpenRouter. |
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/pricing) | Monthly free credits on eligible models; purchasing credits changes tier. No BYOK/paid credits. |
| [OpenCode Zen](https://opencode.ai/docs/zen/) | Only verified free models, some temporary and with data restrictions. Paid models excluded. |
| [SambaNova](https://docs.sambanova.ai/docs/en/models/sambacloud-models) | Free account limits must be verified; no trial-renewal assumption. |
| [SiliconFlow](https://docs.siliconflow.com/quickstart/models) | Regional differences: Chinese free-model list does not imply international paid models are free. |

Existing Gemini/Groq/Z.ai/OpenRouter credentials are reused. New accounts go in the
private `credentials/inference-pool.json` under the OpenCorp data directory, with keys
in `credentials/<provider>-pool.key` (NVIDIA reuses `nvidia-nim-free.key`). Directory
mode 0700, files 0600, no symlinks. Never put these files in Git. Restart the service
after changing configuration; change evidence/key binding to release auth holds.
Each new provider entry has this shape (all example values are synthetic):

```json
{
  "providers": [{
    "id": "mistral",
    "enabled": false,
    "account": "synthetic-account",
    "credentialSha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "billingBlocked": true,
    "verifiedAt": "2026-09-13T00:00:00Z",
    "expiresAt": "2026-09-14T00:00:00Z",
    "evidence": "Record actual free-mode/no-billing settings and official model eligibility",
    "renewable": true,
    "publicOnly": true,
    "evaluationOnly": true,
    "concurrency": 1,
    "models": [{"id":"EXACT_VERIFIED_MODEL","context":32768,"quality":2,"tools":true}],
    "limits": [{"requests":1,"periodMs":60000}]
  }]
}
```

Fill exact model capabilities, free eligibility, account-specific limits and the key
hash before enabling. `billingBlocked` records a verified provider-side restriction;
it is not itself a billing API or a software spending cap. Do not enable an account
whose free exhaustion can silently charge. Unsupported official protocols require an
adapter, not an arbitrary endpoint override. All registered routes use fixed HTTPS
origins and reject redirects. Secrets and raw errors never enter the quota ledger.
