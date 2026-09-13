import { describe, expect, it } from 'vitest';
import { corporateFixture, fixtureTools } from '../scripts/verify-nemotron-corporate-profile.js';
import { expectedAction } from '../scripts/verify-nemotron-profile.js';

describe('strict corporate profile fixture', () => {
  it('returns real strict field errors and accepts a corrected action only after source inspection', () => {
    const fixture = corporateFixture();
    expect(fixture.call('fixture_action', expectedAction).isError).toBe(true);
    expect(fixture.action).toBeUndefined();
    expect(fixture.call('fixture_source_read', { sourceId: 'invented' }).isError).toBe(true);
    expect(fixture.call('fixture_source_read', { sourceId: expectedAction.sourceId }).isError).toBeUndefined();
    const { spending, ...rest } = expectedAction;
    const malformed = fixture.call('fixture_action', { ...rest, spendingLimit: spending });
    expect(malformed.isError).toBe(true);
    expect(malformed.content[0]?.text).toContain('spending');
    expect(malformed.content[0]?.text).toContain('unrecognized_keys');
    expect(fixture.action).toBeUndefined();
    expect(fixture.call('fixture_action', expectedAction).isError).toBeUndefined();
    expect(fixture.action).toEqual(expectedAction);
    expect(fixture.call('fixture_action', expectedAction).isError).toBe(true);
    expect(fixture.calls.filter(call => call.name === 'fixture_action' && call.accepted)).toHaveLength(1);
    expect(JSON.stringify(fixture.calls)).not.toContain('spendingLimit');
  });
  it('advertises the same strict schema used to reject unknown fields', () => {
    const schema = fixtureTools.find(tool => tool.name === 'fixture_action')!.inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain('spending');
    const fixture = corporateFixture();
    fixture.call('fixture_source_read', { sourceId: expectedAction.sourceId });
    expect(fixture.call('fixture_action', { ...expectedAction, headcount: 100 }).isError).toBe(true);
    expect(fixture.call('other_tool', expectedAction).isError).toBe(true);
    expect(fixture.action).toBeUndefined();
  });
});
