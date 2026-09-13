import { describe, expect, it } from 'vitest';
import { isExactFreeModelId, zeroPricing } from '../src/runtime/openrouter.js';

describe('OpenRouter zero-cost metadata admission', () => {
  it('accepts explicit zero prices including optional zero ancillary dimensions', () => {
    expect(zeroPricing({ prompt: '0', completion: '0.000', request: 0, image: '0', internal_reasoning: '0', input_cache_write: '0', discount: 0 })).toBe(true);
  });
  it.each([null, undefined, false, [], {}, { prompt: '0' }, { completion: '0' }])('refuses absent or incomplete pricing %j', pricing => {
    expect(zeroPricing(pricing)).toBe(false);
  });
  it.each([null, '', ' ', false, [], {}, Number.NaN, Number.POSITIVE_INFINITY, 'NaN', 'Infinity', '-0.01', '0.0000000001'])('does not coerce ambiguous or billable prices %j to free', price => {
    expect(zeroPricing({ prompt: '0', completion: price })).toBe(false);
  });
  it.each(['request', 'image', 'web_search', 'internal_reasoning', 'input_cache_read', 'input_cache_write', 'input_audio', 'future_billable_dimension'])('rejects positive %s even with free text tokens', field => {
    expect(zeroPricing({ prompt: '0', completion: '0', [field]: '0.000001' })).toBe(false);
  });
  it('refuses unvalidated nested pricing tiers rather than trusting the zero base', () => {
    expect(zeroPricing({ prompt: '0', completion: '0', tiers: [{ min_prompt_tokens: 1000, completion: '0.1' }] })).toBe(false);
  });
});

describe('OpenRouter explicit free identities', () => {
  it('accepts exact provider/model free variant identifiers', () => {
    expect(isExactFreeModelId('nvidia/nemotron-3.5-lightning:free')).toBe(true);
    expect(isExactFreeModelId('nvidia/nemotron-3-super-120b-a12b:free')).toBe(true);
  });
  it.each(['openrouter/auto', 'openrouter/free', '@preset/free', 'nvidia/model', 'nvidia/model:free:online', 'nvidia/model:online:free',
    'nvidia/model:free?provider=paid', 'https://evil.test/model:free', '../model:free', 'nvidia/model/free', 'nvidia/model:free\n'])('rejects routing/suffix/URL ambiguity: %s', id => {
    expect(isExactFreeModelId(id)).toBe(false);
  });
});
