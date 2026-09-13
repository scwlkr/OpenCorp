/** Discovery references are not pricing authority. These are fixed official origins. */
export const providerRegistry = {
  gemini: { endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', source: 'https://ai.google.dev/gemini-api/docs/pricing', access: 'free-tier' },
  groq: { endpoint: 'https://api.groq.com/openai/v1/chat/completions', source: 'https://console.groq.com/docs/rate-limits', access: 'free-tier' },
  openrouter: { endpoint: 'https://openrouter.ai/api/v1/chat/completions', source: 'https://openrouter.ai/docs/api_reference/limits', access: 'zero-price-models' },
  zai: { endpoint: 'https://api.z.ai/api/paas/v4/chat/completions', source: 'https://docs.z.ai/guides/overview/pricing', access: 'zero-price-models' },
  cerebras: { endpoint: 'https://api.cerebras.ai/v1/chat/completions', source: 'https://inference-docs.cerebras.ai/support/rate-limits', access: 'trial-account-dependent' },
  nvidia: { endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions', source: 'https://docs.api.nvidia.com/nim/docs/product', access: 'evaluation-only' },
  mistral: { endpoint: 'https://api.mistral.ai/v1/chat/completions', source: 'https://docs.mistral.ai/admin/billing-usage/subscriptions', access: 'free-tier' },
  huggingface: { endpoint: 'https://router.huggingface.co/v1/chat/completions', source: 'https://huggingface.co/docs/inference-providers/pricing', access: 'monthly-credit' },
  cloudflare: { endpoint: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions', source: 'https://developers.cloudflare.com/workers-ai/platform/pricing/', access: 'daily-neurons' },
  cohere: { endpoint: 'https://api.cohere.ai/compatibility/v1/chat/completions', source: 'https://docs.cohere.com/docs/rate-limits', access: 'evaluation-only' },
  vercel: { endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions', source: 'https://vercel.com/docs/ai-gateway/pricing', access: 'monthly-credit' },
  zen: { endpoint: 'https://opencode.ai/zen/v1/chat/completions', source: 'https://opencode.ai/docs/zen/', access: 'temporary-free-models' },
  sambanova: { endpoint: 'https://api.sambanova.ai/v1/chat/completions', source: 'https://docs.sambanova.ai/docs/en/models/sambacloud-models', access: 'free-tier-account-dependent' },
  siliconflow: { endpoint: 'https://api.siliconflow.cn/v1/chat/completions', source: 'https://docs.siliconflow.com/quickstart/models', access: 'regional-zero-price-models' },
} as const;
export type RegisteredProvider = keyof typeof providerRegistry;
