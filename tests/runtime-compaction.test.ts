import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@opencode-ai/sdk/v2';
import { runtimeConfig, runtimeCompletion, startRunWatchdog } from '../src/runtime/index.js';
import type { LocalModel } from '../src/runtime/types.js';

// Compatibility fixture for the pinned upstream overflow.ts usable/isOverflow
// semantics, reduced to our explicit output limit and reported total tokens.
// https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/overflow.ts
// Unlike testing config keys alone, this catches reserved being ignored when
// input is absent, which caused the real fifth CEO request to reach 30,403 tokens.
function upstreamOverflow(config: Config, total: number): boolean {
  const limit = Object.values(config.provider!['opencorp-local'].models!)[0].limit!;
  const reserved = config.compaction?.reserved ?? Math.min(20_000, limit.output!);
  const usable = limit.input ? Math.max(0, limit.input - reserved) : Math.max(0, limit.context! - limit.output!);
  return config.compaction?.auto !== false && total >= usable;
}

function config(contextTokens: 16384 | 32768): Config {
  return runtimeConfig({ alias: `opencorp-test-${contextTokens}:latest`, capabilities: ['tools'], contextTokens } as LocalModel,
    'http://127.0.0.1:1', 'scoped-fixture', true);
}

// Pinned llm/request.ts applies agent.prompt on each inference, but normal
// compaction.ts creates a new user without system. These reduced upstream
// semantics reproduce the observed 3,365 -> 0 system-field loss.
function upstreamSystem(config: Config, user: { system?: string }): string {
  return [config.agent?.employee?.prompt, user.system].filter(Boolean).join('\n');
}

describe('pinned OpenCode provider timer compatibility', () => {
  it.each([16384, 32768] as const)('removes hidden provider timers while preserving the %s-profile run deadline', context => {
    // Exact default/enable conditions from provider.ts1688–1703: Bun fetch's
    // timeout:false does not disable these separate OpenCode controllers.
    // https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/provider/provider.ts#L1688
    function upstreamTimers(options: NonNullable<NonNullable<Config['provider']>[string]['options']>) {
      const chunkTimeout = options.chunkTimeout ?? 300000;
      const headerTimeout = options.headerTimeout ?? 300000;
      return { chunk: typeof chunkTimeout === 'number' && chunkTimeout > 0,
        header: typeof (headerTimeout === false ? undefined : headerTimeout) === 'number',
        total: options.timeout !== undefined && options.timeout !== null && options.timeout !== false };
    }
    const current = config(context);
    expect(upstreamTimers({})).toEqual({ chunk: true, header: true, total: false });
    expect(upstreamTimers(current.provider!['opencorp-local'].options!)).toEqual({ chunk: false, header: false, total: false });
    expect(current.agent?.employee?.steps).toBe(32);
    expect(Object.values(current.provider!['opencorp-local'].models!)[0].limit?.output).toBe(4096);
    vi.useFakeTimers();
    const controller = new AbortController();
    const stop = startRunWatchdog(controller, () => ({ latestProgress: 0, activeTools: 0, inferenceActive: true }));
    try {
      vi.advanceTimersByTime(45 * 60000 - 1); expect(controller.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1); expect(controller.signal.reason.message).toBe('Employee run exceeded its bounded execution time');
    } finally { stop(); vi.useRealTimers(); }
  });
});

describe('pinned OpenCode compaction compatibility', () => {
  it('keeps exact employee authority and workspace guidance when compaction drops the user system', () => {
    const authority = 'Employee fixture-employee. Persist exact artifacts through commit_work and require independent review_work. Owner allowance is $0.';
    const options = { system: authority, workspace: '/tmp/owned-fixture/product' };
    const current = runtimeConfig({ alias: 'fixture', capabilities: ['tools'], contextTokens: 32768 } as LocalModel,
      'http://127.0.0.1:1', 'scoped-fixture', true, options);
    const initial = upstreamSystem(current, {});
    const afterAutomaticCompaction = upstreamSystem(current, {});
    expect(initial.split(authority)).toHaveLength(2);
    expect(afterAutomaticCompaction).toBe(initial);
    expect(afterAutomaticCompaction).toContain('/tmp/owned-fixture/product');
    expect(afterAutomaticCompaction).toContain('one-based line offsets');
    expect(afterAutomaticCompaction).toContain('150 lines');
    expect(afterAutomaticCompaction).toContain('reread only specific missing or changed sections');
    const oldConfig = config(32768);
    expect(upstreamSystem(oldConfig, { system: authority })).toContain(authority);
    expect(upstreamSystem(oldConfig, {})).not.toContain(authority);
  });

  it('preserves standalone requests and reports a native step-limit checkpoint without claiming ordinary completion', () => {
    const standalone = runtimeConfig({ alias: 'fixture', capabilities: ['tools'], contextTokens: 16384 } as LocalModel,
      'http://127.0.0.1:1', 'scoped-fixture', false, { system: 'Disposable local qualification instructions.', workspace: '/tmp/qualification' });
    expect(upstreamSystem(standalone, {})).toContain('Disposable local qualification instructions.');
    expect(standalone.mcp).toEqual({});
    expect(standalone.agent?.employee?.steps).toBe(32);
    expect(runtimeCompletion('stop', 0)).toEqual({ finishReason: 'stop', continuations: 0, outputLimit: 4096, exhausted: false });
    const native = { limit: 32 as const, request: 32, toolEnabledSteps: 27 };
    const completion = runtimeCompletion('stop', 0, native);
    expect(completion).toEqual({ finishReason: 'stop', continuations: 0, outputLimit: 4096, exhausted: true, nativeStepLimit: native });
    native.request = 34;
    expect(completion.nativeStepLimit?.request).toBe(32);
  });

  it('compacts the actual CEO history before the fifth oversized tool continuation', () => {
    const corrected = config(32768);
    const actualCompletedTotals = [13423, 17771, 22890, 27489];
    expect(actualCompletedTotals.map(tokens => upstreamOverflow(corrected, tokens))).toEqual([false, false, false, true]);
    expect(upstreamOverflow(corrected, 24575)).toBe(false);
    expect(upstreamOverflow(corrected, 24576)).toBe(true);
    const missingInput = structuredClone(corrected);
    delete Object.values(missingInput.provider!['opencorp-local'].models!)[0].limit!.input;
    expect(upstreamOverflow(missingInput, 27489)).toBe(false);
  });

  it('preserves the 16K threshold and keeps the observed complex prompt on 32K', () => {
    const small = config(16384);
    expect(upstreamOverflow(small, 8192)).toBe(false);
    expect(upstreamOverflow(small, 12287)).toBe(false);
    expect(upstreamOverflow(small, 12288)).toBe(true);
    // The real founder's initial input alone is 12,749 tokens. Earlier
    // compaction cannot shrink that fixed prompt/tools floor; it requires 32K.
    expect(upstreamOverflow(small, 12749)).toBe(true);
    expect(upstreamOverflow(config(32768), 12749)).toBe(false);
  });
});
