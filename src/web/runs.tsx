import React, { useEffect, useState } from 'react';
import type { CompanySnapshot, EmployeeRun, Assignment } from '../core/types.js';
import { request } from './api.js';

type Observation = { at: string; type: string; payload: any };
type Inspection = { run: EmployeeRun; assignment: Assignment; employee: string; available: boolean; selected: boolean; limitation: string; records: Observation[] };
function inferredWait(capture: Inspection) {
  if (capture.run.status !== 'running') return capture.run.status;
  const activeTools = new Set<string>();
  let inference = false, capacity = false;
  for (const event of capture.records) {
    if (event.type === 'runtime.tool') {
      if (['pending', 'running'].includes(event.payload.state?.status)) activeTools.add(event.payload.id);
      else activeTools.delete(event.payload.id);
    }
    if (event.type === 'runtime.inference.started') inference = true;
    if (['runtime.inference.finished', 'runtime.inference.failed'].includes(event.type)) inference = false;
    if (/capacity|cooldown/.test(event.type)) capacity = true;
    if (event.type === 'runtime.inference.started') capacity = false;
  }
  return activeTools.size ? 'tool wait' : capacity ? 'capacity wait' : inference ? 'inference wait' : 'between observed actions; cause unknown';
}
export function RunsView({ state, id }: { state: CompanySnapshot; id?: string }) {
  const [capture, setCapture] = useState<Inspection>();
  const [error, setError] = useState('');
  useEffect(() => {
    setCapture(undefined); setError('');
    if (!id) return;
    const controller = new AbortController(); let busy = false;
    const refresh = async () => {
      if (busy) return; busy = true;
      try { const result = await request<Inspection>(`runs/${encodeURIComponent(id)}/inspection`, undefined, controller.signal); if (!controller.signal.aborted) { setCapture(result); setError(''); } }
      catch (failure) { if (!controller.signal.aborted) setError(String(failure)); }
      finally { busy = false; }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [id]);
  if (!id) return <><p>Ongoing and recent employee runs. Open a run to inspect supplied context, tools and recorded outcomes.</p><div className="table-scroll"><table><thead><tr><th>Assignment</th><th>Employee</th><th>Model</th><th>State</th></tr></thead><tbody>{state.runs.slice(-100).reverse().map(run => <tr key={run.id}><td><a href={`#runs/${run.id}`}>{state.assignments.find(item => item.id === run.assignmentId)?.title || run.assignmentId}</a></td><td>{state.employees.find(item => item.id === run.employeeId)?.name}</td><td>{run.modelId}</td><td>{run.status}</td></tr>)}</tbody></table></div><h2>Waiting assignments</h2>{state.assignments.filter(item => ['blocked', 'queued'].includes(item.status)).map(item => <p key={item.id}>{item.title}: {item.blockedReason || (item.dependencies.length ? 'Dependencies recorded; inspect assignment status' : 'Queued; capacity or scheduler eligibility not yet established')}</p>)}</>;
  return <><a href="#runs">← All runs</a>{error && <p role="alert">{error}</p>}{capture && <>
    <h2>{capture.assignment.title}</h2><p>{capture.employee} · {capture.run.modelId} · {capture.run.status}</p>
    <p><strong>Inferred diagnosis:</strong> {inferredWait(capture)}. Based on recorded events; not an employee explanation.</p>
    {capture.assignment.blockedReason && <p><strong>Recorded assignment blocker:</strong> {capture.assignment.blockedReason}</p>}
    <p>{capture.limitation}</p><p>Capture: 16 MiB per run, 128 MiB total. Recent runs: 7 days; selected failures: up to 30 days, subject to total storage limit.</p>
    {capture.run.status === 'failed' && capture.available && <button disabled={capture.selected} onClick={() => { void request(`runs/${encodeURIComponent(id)}/inspection/preserve`, {}).then(() => setCapture({ ...capture, selected: true })).catch(failure => setError(String(failure))); }}>{capture.selected ? 'Failure selected' : 'Keep failure for investigation'}</button>}
    <details><summary>Run and assignment records (current assignment)</summary><pre>{JSON.stringify({ run: capture.run, assignment: capture.assignment }, null, 2)}</pre></details>
    {capture.records.map((event, index) => <details key={index}><summary>{new Date(event.at).toLocaleTimeString()} · {event.type === 'employee.explanation' ? 'Employee explanation' : 'Recorded event'} · {event.type}</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>)}
  </>}</>;
}
