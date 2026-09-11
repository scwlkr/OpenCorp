export interface LocalInferenceProfile { id: 'qwen-no-thinking-v1'; reasoningEffort: 'none' }

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
  capabilities: string[];
  contextTokens: number;
  provider: 'ollama';
  local: true;
  available: boolean;
}

export interface RuntimeEvent {
  type: string;
  runId?: string;
  payload: unknown;
}

export interface RuntimeOptions {
  dataRoot: string;
  ollamaBinary?: string;
  modelStore?: string;
  onEvent?: (event: RuntimeEvent) => void;
}

export interface ExecuteRequest {
  runId: string;
  employeeId: string;
  workspace: string;
  modelId: string;
  system: string;
  prompt: string;
  brokerUrl?: string;
  token?: string;
  imagePaths?: string[];
  timeoutMs?: number;
  contextTokens?: 16384 | 32768;
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
  completion: { finishReason: string | null; continuations: number; outputLimit: 4096; exhausted: boolean; nativeStepLimit?: NativeStepLimit; finalResponse?: FinalResponseReceipt };
}

export type RuntimeFailureCode = 'output_limit_exhausted' | 'run_budget_exhausted' | 'step_budget_exhausted' | 'runtime_failed' | 'checkpoint_superseded';
export interface RuntimeFailureEvidence {
  runId: string; sessionId?: string; modelId: string; artifactIdentity: string; inferenceProfile?: LocalInferenceProfile;
  usage: RuntimeResult['usage']; diagnosticsPath: string;
  messagesPath?: string; messagesSource: 'api' | 'database' | 'unavailable'; databasePath: string;
  latestAssistant?: { id: string; finishReason: string | null; completed: boolean; errorName?: string };
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
} as const;

export const CONTEXT_TOKENS = 16384;
