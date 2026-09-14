# Scoped compute allowances

Management writes the recommendation in Markdown and emails it through `owner.propose`. Add `computeGrant` with `ceilingMicrousd` (integer millionths of one USD), existing `assignmentIds`, and exact `routes` objects such as `{"provider":"openai","model":"gpt-4.1-mini-2025-04-14"}` (no provider prefix in `model`). Each route can set `maxOutputTokens`, default 1024; dispatch cannot exceed that approved per-request ceiling. Use `channel:"email"`, a future `expiresAt`, and no `actionId`. Include expected result, time/cost estimate basis, uncertainty and a free alternative in the prose. The service adds the total ceiling, exact routes and frozen named work to the email. Only the existing authenticated, proposal-specific Owner reply approves it. Generic chat, policy updates and employee commands cannot authorize it.

After approval, an assigned employee uses the shared broker's `compute_request` with `proposalId`, `provider`, `model`, a bounded text `prompt`, stable `dedupeKey`, and optional `maxOutputTokens` (default 1024). This is supplemental text inference: employee identity, default engine and ordinary routing persist. It is not an automatic paid fallback. Confidential assignments and their descendants are denied. Approval does not install credentials or grant a private-data route. Do not put private material into an ordinary assignment to evade that boundary.

The grant freezes employee, assignment, project, title, instructions, acceptance and data classification. Revised work needs a fresh proposal. Changing policy invalidates the previous grant. All routes and assignments in one grant share its total ceiling. Expiration prevents new requests; it does not cancel or erase already dispatched charges. Unused allowance never becomes general permission.

## Dispatch and recovery

Admission runs in a SQLite immediate transaction at the transport boundary. The request's full worst-case cost is durably reserved before HTTP dispatch, serialized across concurrent callers. Stale/unknown pricing, missing credentials, mismatched scope, stopped/revoked work or insufficient allowance prevents dispatch. No caller-supplied price or provider options are accepted. One text completion, default service tier, no streaming, server tools, images, caching surcharges, redirects, SDK retries or alternate provider fallback.

Inspect existing `attention` and `actions` records using `company_detail`. Each `compute.infer` action retains its grant, assignment, request hash, pricing evidence, integer `reservedMicrousd`, provider receipt and useful returned text/usage. A repeated request key returns the retained result; changed content under that key is rejected. An interrupted or otherwise unconfirmed response remains uncertain with the entire reservation charged against the grant. Stop cannot undo an HTTP request already sent. Restart and backup restore preserve grants and effects; never retry an uncertain request under a new key.

Successful requests also retain the full reservation. Observed token costs are estimates at the protected upper rates, not final billing and not a refund. This conservative implementation can exhaust its dispatch allowance before actual charges reach the ceiling. Choose a free route or seek a new explicit allowance; no automated refund/reconciliation scheme is added. Price assumptions must bound all account charges; if that cannot be established, do not configure the route.

## Protected route configuration

No paid configuration is installed by default. Parent transport reads `credentials/paid-compute.json` and `credentials/paid-compute.key` within the company data directory. The directory must be owned by the service user with mode 0700; both files must be owned regular files with mode 0600, never symlinks. These files are excluded from worker context and portable backups. No existing free-provider credential is reused.

The JSON contains `routes`, each with:

- `provider:"openai"` and a supported exact GPT-4.1, mini or nano snapshot ending `-2025-04-14`.
- `contextTokens:1047576` and `maxOutputTokens` from 1 through 32768.
- Positive integer `inputMicrousdPerToken` and `outputMicrousdPerToken`, rounded **up** to cover all account charges, including any taxes/fees. `allChargesIncluded:true` is a protected operator attestation, not live billing verification.
- `verifiedAt`, `expiresAt` (valid at dispatch, at most 24 hours apart), and the official OpenAI HTTPS pricing `source`.

The adapter uses only `https://api.openai.com/v1/chat/completions`. Models and upper rates remain configurable within this supported text protocol. Other providers require a separately reviewed adapter that can safely bound all charges; the tool cannot dispatch an arbitrary URL or paid OpenRouter request.

For a conservative bound without introducing tokenization infrastructure, reserve the model's *entire input context* plus the requested maximum output at the upper rates. GPT-4.1 mini's published standard rates were $0.40/$1.60 per million input/output tokens when inspected September 14, 2026; these are proposal estimates, not installed account-wide rates. With verified all-in upper rates of 1/2 USD millionths per token, a 1024-output request reserves $1.049624 regardless of its likely much lower actual cost. Inspect current [model/pricing information](https://developers.openai.com/api/docs/models/gpt-4.1-mini) and account terms before creating protected configuration. The [Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create) bounds output with `max_completion_tokens` and reports usage; neither a transport error nor missing usage proves zero billing.

## Validation

Use the existing email/service/employee-tool boundaries with a nonbillable transport for spending checks. Cover exact approval, aggregate concurrent overcommit, expiry, changed scope, unknown pricing and uncertain effects across restart/restore. Observe an actual management proposal and email receipt separately. Automated checks do not establish product adoption, model suitability or recipient reading. Actual paid inference is not required or authorized to demonstrate this feature.
