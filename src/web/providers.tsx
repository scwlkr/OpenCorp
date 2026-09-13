import React, { useEffect, useRef, useState } from 'react';
import type { ProviderId, ProviderStatus } from '../core/provider-status.js';
import { request } from './api.js';

const names: Record<ProviderId, string> = { local: 'Local Ollama', openrouter: 'OpenRouter', groq: 'Groq', gemini: 'Google Gemini', zai: 'Z.ai' };
const consoles: Partial<Record<ProviderId, string>> = {
  openrouter: 'https://openrouter.ai/settings/credits',
  groq: 'https://console.groq.com/settings/limits',
  zai: 'https://z.ai/manage-apikey/rate-limits',
  gemini: 'https://aistudio.google.com/rate-limit',
};
const time = (value?: string) => value ? new Date(value).toLocaleString() : 'Not recorded';

function Quota({ provider }: { provider: ProviderStatus }) {
  if (provider.id === 'local') return <p className="muted">No provider request allowance. Capacity depends on available memory and active work.</p>;
  const headers = provider.quota.headers;
  const remaining = headers?.['x-ratelimit-remaining-requests'];
  const limit = headers?.['x-ratelimit-limit-requests'];
  return <div className="provider-quota">
    <h3>Allowance</h3>
    {provider.id === 'groq' && remaining !== undefined ? <>
      <p className="quota-number">{Number(remaining).toLocaleString()} <span>daily requests remaining{limit !== undefined ? ` / ${Number(limit).toLocaleString()}` : ''} at last check</span></p>
      <p className="muted">Reported for {provider.quota.modelId || provider.lastTest?.modelId || 'the tested model'} in this organization. Other activity can use this allowance.</p>
      {headers?.['x-ratelimit-remaining-tokens'] !== undefined && <p>{String(headers['x-ratelimit-remaining-tokens'])} tokens remaining in the minute window.</p>}
      {headers?.['x-ratelimit-reset-requests'] !== undefined && <p className="muted">Request window reset in {String(headers['x-ratelimit-reset-requests'])} when observed.</p>}
    </> : <><p className="quota-number">Unknown <span>daily requests remaining</span></p><p className="muted">{provider.id === 'openrouter' ? 'Free requests share an account allowance. Credit balance and the key’s $0 spending limit are not request quotas.' : provider.id === 'gemini' ? 'Limits apply per project and model. Check AI Studio for current usage; daily limits reset at midnight Pacific time.' : provider.id === 'zai' ? 'GLM-4.7-Flash is limited to one in-flight request. Daily allowance is unknown; requests are paced locally.' : 'A response with quota headers is needed to show remaining capacity.'}</p></>}
    {provider.quota.observedAt && <p className="muted">Observed {time(provider.quota.observedAt)}</p>}
    {headers && Object.keys(headers).length > 0 && <details className="record-details"><summary>Reported quota headers</summary><dl className="provider-headers">{Object.entries(headers).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></details>}
  </div>;
}

function ProviderCard({ provider, busy, test }: { provider: ProviderStatus; busy: boolean; test: (provider: ProviderId, modelId: string) => Promise<void> }) {
  const [selected, setSelected] = useState('');
  const modelId = provider.modelIds.includes(selected) ? selected : provider.modelIds[0] || '';
  const local = provider.id === 'local';
  const label = provider.testing ? 'Testing' : provider.health === 'green' ? local ? 'Available' : 'Test passed' : provider.health === 'red' ? 'Needs attention' : 'Not verified';
  const last = provider.lastTest;
  return <article className="section provider-card">
    <div className="section-heading"><div><h2>{names[provider.id]}</h2><p className="muted">{provider.activeRuns} active {provider.activeRuns === 1 ? 'run' : 'runs'} · {provider.configured ? 'Configured' : 'Not configured'}</p></div><span className={`provider-health health-${provider.testing ? 'unknown' : provider.health}`}><span aria-hidden="true"/>{label}</span></div>
    <p className="muted">{provider.reason}</p>
    {provider.cooldown && <p className="banner error">Cooling down until {time(provider.cooldown.retryAt)}. This retry time does not establish a quota reset.</p>}
    <Quota provider={provider}/>
    {!local && <div className="provider-test">
      <h3>Quick connection test</h3><p className="muted">Two tiny free requests: call a local addition tool, then return its answer. Tests API access and tool calling; does not qualify the model for company work.</p>
      <label className="field-label" htmlFor={`provider-${provider.id}`}>Test model</label>
      <select id={`provider-${provider.id}`} value={modelId} disabled={busy || provider.testing || !provider.modelIds.length} onChange={event => setSelected(event.target.value)}>{!provider.modelIds.length && <option value="">No eligible model configured</option>}{provider.modelIds.map(id => <option key={id} value={id}>{id}</option>)}</select>
      <div className="button-row"><button disabled={busy || provider.testing || !modelId || !provider.configured || provider.activeRuns > 0 || Boolean(provider.cooldown && Date.parse(provider.cooldown.retryAt) > Date.now())} onClick={() => { void test(provider.id, modelId); }}>{provider.testing ? 'Testing…' : 'Test free connection'}</button>{consoles[provider.id] && <a href={consoles[provider.id]} target="_blank" rel="noreferrer">Provider console ↗</a>}</div>
      {provider.activeRuns > 0 && <p className="muted">Test available when this provider’s current work finishes.</p>}
      {last && <div className={`provider-result ${last.status === 'failed' ? 'failed' : ''}`}><strong>{last.status === 'passed' ? 'Response and tool test passed' : 'Last test failed'}</strong><p>{last.modelId}</p><p>Tool: {last.toolPassed ? 'passed' : 'not passed'} · Answer: {last.responsePassed ? 'passed' : 'not passed'} · {last.requests} requests · {(last.latencyMs / 1000).toFixed(1)}s</p>{last.errorCode && <p>{last.errorCode.replaceAll('_', ' ')}{last.httpStatuses.length > 0 ? ` · HTTP ${last.httpStatuses.join(', ')}` : ''}</p>}<small>{time(last.finishedAt)}</small></div>}
      <p className="muted">{provider.audit.status === 'owner-attested' ? `Free tier checked ${time(provider.audit.verifiedAt)}. Check expires ${time(provider.audit.expiresAt)}.` : provider.audit.status === 'free-pricing-required' ? 'Free model pricing and the dedicated $0 key are checked before each test request.' : 'Free-tier eligibility has not been verified.'}</p>
    </div>}
    {local && <details className="record-details"><summary>{provider.modelIds.length} local models</summary>{provider.modelIds.map(id => <p key={id}>{id}</p>)}</details>}
  </article>;
}

export function ProvidersView() {
  const [providers, setProviders] = useState<ProviderStatus[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [pool, setPool] = useState<any>();
  const alive = useRef(true);
  const refresh = async () => {
    try { const [value,pooled] = await Promise.all([request<{ providers: ProviderStatus[] }>('providers', undefined, AbortSignal.timeout(10_000)),request('inference/providers',undefined,AbortSignal.timeout(10_000))]); if (alive.current) { setProviders(value.providers); setPool(pooled); setError(''); } }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : 'Cannot read provider status'); }
  };
  useEffect(() => { alive.current = true; void refresh(); const timer = window.setInterval(() => { void refresh(); }, 10_000); return () => { alive.current = false; window.clearInterval(timer); }; }, []);
  const test = async (provider: ProviderId, modelId: string) => {
    setBusy(true); setNotice('Testing API access, a local function call, and the final answer…');
    try { await request('providers/test', { provider, modelId }, AbortSignal.timeout(60_000)); if (alive.current) setNotice('Test finished. Results are recorded below.'); }
    catch (failure) { if (alive.current) setNotice(failure instanceof Error ? failure.message : 'Test request failed'); }
    finally { if (alive.current) { setBusy(false); await refresh(); } }
  };
  return <>
    <p className="provider-intro">Connection health and the capacity each provider has actually reported. Green reflects a recent check; availability can change. All remote tests use free inference.</p>
    <div className="button-row provider-refresh"><button className="quiet" onClick={() => { void refresh(); }}>Refresh provider status</button><span className="muted">Refresh reads saved status. It does not send model requests.</span></div>
    {error && <div className="banner error" role="alert">{error}</div>}
    {notice && <div className="banner notice" role="status">{notice}</div>}
    {pool && <section className="section"><h2>Free inference pool</h2><p>Employees can select <code>free-pool</code>. Requests use suitable available models, with automatic fallback and saved cooldowns.</p><p className="muted">Remaining capacity below is a local estimate. Other clients can consume account quota. No paid fallback.</p>
      <div className="provider-summary">{Object.entries(pool.registry).map(([id,entry]:[string,any])=>{const configured=pool.configured.find((p:any)=>p.id===id);const ready=configured?.models.some((m:any)=>m.retryAt<=Date.now());return <div key={id}><strong>{id}</strong><span>{!configured?'Not connected':ready?'Eligible to attempt':'Cooling down / needs configuration'}</span>{configured&&<span>{Math.round(Math.max(0,...configured.models.map((m:any)=>m.remainingFraction))*100)}% local budget remaining{configured.evaluationOnly?' · Evaluation only':''}</span>}<a href={entry.source} target="_blank" rel="noreferrer">Free access terms</a></div>;})}</div>
    </section>}
    {providers && <div className="provider-summary" aria-label="Provider health summary">{providers.map(provider => <div key={provider.id}><strong>{names[provider.id]}</strong><span className={`provider-health health-${provider.testing ? 'unknown' : provider.health}`}><span aria-hidden="true"/>{provider.testing ? 'Testing' : provider.health === 'green' ? 'Test passed' : provider.health === 'red' ? 'Needs attention' : provider.id === 'local' && provider.activeRuns ? `${provider.activeRuns} active run` : 'Not verified'}</span></div>)}</div>}
    {!providers ? <div className="empty">Loading providers…</div> : <div className="provider-grid">{providers.map(provider => <ProviderCard key={provider.id} provider={provider} busy={busy} test={test}/>)}</div>}
  </>;
}
