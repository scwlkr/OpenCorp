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
function AssignmentControls({ assignment, state, changed }: { assignment: Assignment; state: CompanySnapshot; changed?: () => void }) {
  const [guidance, setGuidance] = useState(''), [instructions, setInstructions] = useState(''), [modelId, setModelId] = useState('');
  const [rationale, setRationale] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const employee = state.employees.find(item => item.id === assignment.employeeId);
  const apply = async (command: object) => {
    setBusy(true); setNotice('');
    try { await request('command', command); setNotice('Saved. Subsequent work uses the current assignment and employee model.'); changed?.(); return true; }
    catch (error) { setNotice(String(error)); return false; }
    finally { setBusy(false); }
  };
  if (['completed', 'cancelled'].includes(assignment.status)) return null;
  return <details><summary>Intervene in this assignment{assignment.paused ? ' · Paused' : ''}</summary><div className="workplace-form">
    <p>Pause interrupts this assignment and retains its work. Resume releases that hold after the previous runtime stops and uncertain effects are reconciled. Existing blockers still apply. Sent actions cannot be undone.</p>
    <label>Reason<input value={rationale} onChange={event => setRationale(event.target.value)} /></label>
    <button disabled={busy || !rationale.trim()} onClick={() => void apply({ type: 'assignment.update', assignmentId: assignment.id, paused: !assignment.paused, rationale })}>{assignment.paused ? 'Resume assignment' : 'Pause assignment'}</button>
    <label>Guidance for the next attempt<textarea maxLength={20000} value={guidance} onChange={event => setGuidance(event.target.value)} /></label>
    <button disabled={busy || !rationale.trim() || !guidance.trim()} onClick={() => void apply({ type: 'assignment.update', assignmentId: assignment.id, guidance, rationale }).then(saved => { if (saved) setGuidance(''); })}>Save guidance</button>
    <details><summary>Change subsequent work or model</summary><div className="workplace-form">
      <p>Changes apply to later attempts. Pause first to interrupt the current attempt. Acceptance and permissions remain enforced. Model selection applies to this employee’s subsequent assignments.</p>
      <label>Replacement assignment instructions<textarea value={instructions} placeholder={assignment.instructions} onChange={event => setInstructions(event.target.value)} /></label>
      <button disabled={busy || !rationale.trim() || !instructions.trim()} onClick={() => void apply({ type: 'assignment.update', assignmentId: assignment.id, instructions, rationale })}>Save instructions</button>
      <label>Subsequent employee model (current: {employee?.modelId})<select value={modelId} onChange={event => setModelId(event.target.value)}><option value="">Select registered model</option>{state.models.filter(model => model.available).map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select></label>
      <button disabled={busy || !rationale.trim() || !modelId} onClick={() => void apply({ type: 'employee.model', employeeId: assignment.employeeId, modelId, rationale })}>Save model</button>
    </div></details><p role="status">{notice}</p>
  </div></details>;
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
  if (!id) return <><p>Ongoing and recent employee runs. Open a run to inspect supplied context, tools and recorded outcomes.</p><div className="table-scroll"><table><thead><tr><th>Assignment</th><th>Employee</th><th>Model</th><th>State</th></tr></thead><tbody>{state.runs.slice(-100).reverse().map(run => <tr key={run.id}><td><a href={`#runs/${run.id}`}>{state.assignments.find(item => item.id === run.assignmentId)?.title || run.assignmentId}</a></td><td>{state.employees.find(item => item.id === run.employeeId)?.name}</td><td>{run.modelId}</td><td>{run.status}</td></tr>)}</tbody></table></div><h2>Waiting assignments</h2>{state.assignments.filter(item => ['blocked', 'queued'].includes(item.status)).map(item => <div key={item.id}><p>{item.title}: {item.paused ? 'Paused by operator' : item.blockedReason || (item.dependencies.length ? 'Dependencies recorded; inspect assignment status' : 'Queued; capacity or scheduler eligibility not yet established')}</p><AssignmentControls assignment={item} state={state} /></div>)}</>;
  return <><a href="#runs">← All runs</a>{error && <p role="alert">{error}</p>}{capture && <>
    <h2>{capture.assignment.title}</h2><p>{capture.employee} · {capture.run.modelId} · {capture.run.status}</p>
    <AssignmentControls key={capture.assignment.id} assignment={capture.assignment} state={state} changed={() => { void request<Inspection>(`runs/${encodeURIComponent(id)}/inspection`).then(setCapture).catch(failure => setError(String(failure))); }} />
    <p><strong>Inferred diagnosis:</strong> {inferredWait(capture)}. Based on recorded events; not an employee explanation.</p>
    {capture.assignment.blockedReason && <p><strong>Recorded assignment blocker:</strong> {capture.assignment.blockedReason}</p>}
    <p>{capture.limitation}</p><p>Capture: 16 MiB per run, 128 MiB total. Recent runs: 7 days; selected failures: up to 30 days, subject to total storage limit.</p>
    {capture.run.status === 'failed' && capture.available && <button disabled={capture.selected} onClick={() => { void request(`runs/${encodeURIComponent(id)}/inspection/preserve`, {}).then(() => setCapture({ ...capture, selected: true })).catch(failure => setError(String(failure))); }}>{capture.selected ? 'Failure selected' : 'Keep failure for investigation'}</button>}
    <details><summary>Run and assignment records (current assignment)</summary><pre>{JSON.stringify({ run: capture.run, assignment: capture.assignment }, null, 2)}</pre></details>
    {capture.records.map((event, index) => <details key={index}><summary>{new Date(event.at).toLocaleTimeString()} · {event.type === 'employee.explanation' ? 'Employee explanation' : 'Recorded event'} · {event.type}</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>)}
  </>}</>;
}
