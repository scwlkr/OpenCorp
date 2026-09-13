import type {ProductiveRemoteProfile,ProductiveProviderCap} from '../core/inference-policy.js';
import type { ProviderBackoff } from '../core/provider-backoff.js';
export type LocalInferenceProfile = { id: 'qwen-no-thinking-v1' | 'nemotron-no-thinking-v1'; reasoningEffort: 'none' } | { id: 'qwen-low-reasoning-v1'; reasoningEffort: 'low' };

export interface LocalModel {
  id: string;
  name: string;
  alias: string;
  sourceAlias: string;
  artifactIdentity: string;
  manifestDigest: string;
  templateDigest: string;
  parametersDigest: string;
  /** Enforced by the owned gateway; part of artifactIdentity, not source weights. */
  inferenceProfile?: LocalInferenceProfile;
  size: number;
  sizeClass?: 'micro' | 'small' | 'large';
  capabilities: string[];
  contextTokens: number;
  provider: 'ollama';
  local: true;
  available: boolean;
}

export interface OpenRouterFreeModel extends Omit<LocalModel, 'provider' | 'local' | 'sizeClass' | 'manifestDigest' | 'templateDigest' | 'parametersDigest'> {
  provider: 'openrouter'; local: false; sizeClass: 'remote'; freeOnly: true;
  endpoint: 'https://openrouter.ai/api/v1/chat/completions';
  pricingVerifiedAt: string; pricing: Record<string, string | number>; providers: string[];
}
export type DirectFreeProviderName = 'groq' | 'gemini' | 'zai';
export interface DirectFreeTierAudit {
 provider:DirectFreeProviderName; accountId:string; billingEnabled:false; credentialSha256:string;
 modelIds:string[]; verifiedAt:string; expiresAt:string; evidence:string;
 pricing?:{source:'https://docs.z.ai/guides/overview/pricing';modelId:'glm-4.7-flash';input:0;cachedInput:0;cachedInputStorage:0;output:0;verifiedAt:string};
}
export interface DirectFreeOptions {
 rateBudgetPath?:string;
 modelIds:string[];
 /** Fresh protected Owner evidence, not a claim of live provider billing verification. */
 readCredentials:()=>Promise<{apiKey:string;audit:DirectFreeTierAudit}>;
}
export interface DirectFreeModel extends Omit<LocalModel,'provider'|'local'|'sizeClass'|'manifestDigest'|'templateDigest'|'parametersDigest'> {
 provider:DirectFreeProviderName; local:false; sizeClass:'remote'; freeOnly:true; endpoint:string;
 tierVerification:'owner-tier-audit'; tierVerifiedAt:string; tierExpiresAt:string;
}
export interface PooledModel extends Omit<DirectFreeModel, 'provider' | 'tierVerification' | 'tierVerifiedAt' | 'tierExpiresAt'> { provider: 'pool' }
export type RuntimeModel = LocalModel | OpenRouterFreeModel | DirectFreeModel | PooledModel;

export interface RuntimeEvent {
  type: string;
  runId?: string;
  payload: unknown;
}

export interface RuntimeOptions {
  freePool?: import('./free-pool/pool.js').FreeInferencePool;
  dataRoot: string;
  /** Owner-approved exact free IDs; credential resolved only in the parent transport. */
  directFree?: Partial<Record<DirectFreeProviderName,DirectFreeOptions>>;
  openRouterFree?: { rateBudgetPath?:string; modelIds: string[]; readApiKey: () => Promise<string>; noByokVerified: true; cooldown?: { read: () => ProviderBackoff | undefined; write: (value: ProviderBackoff | undefined) => void } };
  ollamaBinary?: string;
  modelStore?: string;
  /** Trusted opt-in qualification only; absent preserves the default Nemotron behavior. */
  nemotronInferenceProfile?: 'nemotron-no-thinking-v1';
  onEvent?: (event: RuntimeEvent) => void;
  resourceBudget?: { maxConcurrentTurns?: number; maxProductiveTurns?: number; productiveArtifactIdentity?: string; productiveRemoteModelId?: string; productiveRemoteArtifactIdentity?: string; productiveRemoteProfiles?: ProductiveRemoteProfile[]; productiveProviderCaps?: ProductiveProviderCap[]; maxSocialTurns?: number; maxLoadedModels?: number; minFreeMemoryBytes?: number };
}

export interface ExecuteRequest {
  freeInferencePool?: boolean;
  dataClass?: 'public' | 'internal' | 'confidential';
  runId: string;
  employeeId: string;
  workspace: string;
  modelId: string;
  instructionRevision?: { roleVersion: number; policyRevision: number };
  system: string;
  prompt: string;
  brokerUrl?: string;
  token?: string;
  imagePaths?: string[];
  timeoutMs?: number;
  contextTokens?: 16384 | 32768 | 49152;
  workload?: 'productive' | 'social';
  /** Trusted scheduler selection for corporate-only formation work; not a model argument. */
  corporateOnly?: boolean;
  /** Trusted exact provisioning packet selected by the scheduler, never a model argument. */
  provisionOnly?: boolean;
  /** Trusted scheduler confirms no effects precede initial inference; rechecked on deferral. */
  deferInitialPoolWait?: boolean;
  /** Trusted current Owner policy exception, independently intersected with runtime configuration. */
  directFreeModels?: string[];
  openRouterFreeModels?: string[];
  /** Constructed by the trusted product dependency adapter, never from model arguments. */
  toolEnvironment?: ToolEnvironment;
  onSession?: (sessionId: string) => void | Promise<void>;
  onEvent?: (event: RuntimeEvent) => void;
  /** Trusted scheduler predicate only; revalidates the exact current-run checkpoint. */
  finalResponseCheckpoint?: () => boolean;
  signal?: AbortSignal;
}

export interface FinalResponseReceipt {
  state: 'prepared' | 'observed' | 'uncertain' | 'withdrawn';
  sessionId: string; previousMessageId: string; messageId?: string;
  instructionSha256: string; disabledToolCount: number; requestedAt: string;
  path: string;
}

export interface ToolEnvironment {
  binPaths: string[];
  readPaths: string[];
  writePaths: string[];
  variables: Record<string, string>;
}

/** OpenCode counts internal compaction iterations toward agent.steps as well. */
export interface NativeStepLimit { limit: 32; request: number; toolEnabledSteps: number }

export interface RuntimeResult {
  sessionId: string;
  text: string;
  modelId: string;
  artifactIdentity: string;
  inferenceProfile?: LocalInferenceProfile;
  usage: { inputTokens: number; outputTokens: number; requests: number; durationMs: number };
  messagesPath: string;
  diagnosticsPath: string;
  completion: { finishReason: string | null; continuations: number; outputLimit: 4096 | 1024; exhausted: boolean; nativeStepLimit?: NativeStepLimit; finalResponse?: FinalResponseReceipt };
}

export type RuntimeFailureCode = 'runtime_cleanup_uncertain' | 'output_limit_exhausted' | 'run_budget_exhausted' | 'step_budget_exhausted' | 'runtime_failed' | 'checkpoint_superseded' | 'provider_capacity_wait';
export interface RuntimeFailureEvidence {
  runId: string; sessionId?: string; modelId: string; artifactIdentity: string; inferenceProfile?: LocalInferenceProfile;
  usage: RuntimeResult['usage']; diagnosticsPath: string;
  messagesPath?: string; messagesSource: 'api' | 'database' | 'unavailable'; databasePath: string;
  latestAssistant?: { id: string; finishReason: string | null; completed: boolean; errorName?: string };
  providerWait?: { provider: string; retryAt: string };
  continuations: number; code: RuntimeFailureCode; error: string; capturedAt: string; nativeStepLimit?: NativeStepLimit; finalResponse?: FinalResponseReceipt;
}
export class RuntimeExecutionError extends Error {
  readonly evidence?: RuntimeFailureEvidence;
  constructor(readonly code: RuntimeFailureCode, message: string, readonly result?: RuntimeResult, options?: ErrorOptions & { evidence?: RuntimeFailureEvidence }) {
    super(message, options); this.name = 'RuntimeExecutionError'; this.evidence = options?.evidence;
  }
}

export const MODEL_ALIASES = {
  'qwen-main': 'wlkr-management-qwen3.8-27b-q4-k-m:latest',
  nemotron: 'wlkr-management-nemotron-3.5-lightning-30b-a3b-q4-0:latest',
  small: 'qwen3.5:4b',
  'micro-06': 'qwen3:0.6b',
  'micro-17': 'qwen3:1.7b',
  'micro-4': 'qwen3:4b-instruct',
} as const;

export const CONTEXT_TOKENS = 16384;
