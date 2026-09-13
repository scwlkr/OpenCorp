export interface PoolModel {
  id: string;
  context: number;
  quality: 1 | 2 | 3;
  tools: boolean;
  json?: boolean;
  /** Explicit compatibility: auto-only endpoints cannot serve forced tools. */
  autoToolsOnly?: boolean;
}
export interface PoolLimit {
  scope: string;
  requests?: number;
  tokens?: number;
  /** Rolling local reservations. Zero means a non-renewing trial allowance. */
  periodMs: number;
}
export interface PoolRequest {
  /** Local observer only; never serialized or supplied by model tool arguments. */
  onDispatch?: (body: Record<string, unknown>) => void;
  messages: any[];
  tools?: any[];
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: 'json_object' };
  quality?: 1 | 2 | 3;
  purpose?: 'work' | 'evaluation';
  /** Never route confidential inputs to public/free services. */
  dataClass?: 'public' | 'internal' | 'confidential';
}
export interface PoolCompletion {
  id: string;
  object: 'chat.completion';
  model: string;
  choices: Array<{ index: number; message: any; finish_reason: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens?: number };
}
export interface PoolProvider {
  id: string;
  /** Account/project quota identity, shared by all its models; never an API key. */
  scope: string;
  models: PoolModel[];
  limits: PoolLimit[];
  concurrency: number;
  renewable: boolean;
  /** Calendar reset only when documented; otherwise backoff remains an estimate. */
  dailyReset?: 'utc' | 'pacific';
  evaluationOnly?: boolean;
  publicOnly?: boolean;
  /** Includes configuration/credential identity, used to release repaired auth holds. */
  revision: string;
  available: () => Promise<boolean>;
  complete: (model: PoolModel, request: PoolRequest, signal: AbortSignal) => Promise<{ completion: PoolCompletion; headers: Headers }>;
}
export class PoolAttemptError extends Error {
  constructor(readonly status: number, readonly headers = new Headers(), readonly quota = false) {
    super(`Free provider request failed (${status}); upstream content withheld`);
  }
}
export class PoolUnavailableError extends Error {
  constructor(readonly retryAt: number) { super('No eligible free inference capacity; retry after the indicated time'); }
}

export class PoolRequestUnsupportedError extends Error {
  constructor() { super('No configured free model supports this request; revise its context or capabilities before retrying'); }
}

export class PoolContextOverflowError extends Error {
  constructor() { super('Conversation history exceeds compatible free model capacity'); }
}
