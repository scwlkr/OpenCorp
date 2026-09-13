import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import type { Artifact, CompanySnapshot, Project } from '../core/types.js';
import { OwnerClient } from '../cli/client.js';
import { stripVTControlCharacters } from 'node:util';
import { describeNarrative, employeeDisplayName } from '../core/narratives.js';
import { deliveriesFor, deliveryFor } from '../core/delivery.js';

const tabs = ['Overview', 'Products', 'Projects', 'Employees', 'Decisions', 'Attention', 'CEO chat', 'Departments', 'Recruitment', 'Workplace', 'Responsibilities', 'Command'];
function clean(value: unknown): string { return Array.from(stripVTControlCharacters(String(value ?? ''))).filter((character) => { const code = character.charCodeAt(0); return code === 10 || code === 9 || (code >= 32 && !(code >= 127 && code <= 159)); }).join(''); }
function narratives(values: unknown[]): string {
  return values.length ? values.map((value) => { const item = describeNarrative(value); return clean([item.title, item.rationale, item.measure && `Success measure: ${item.measure}`, item.status && `Status: ${item.status.replaceAll('_', ' ')}`].filter(Boolean).join('\n')); }).join('\n\n') : 'None recorded';
}
function employeeName(state: CompanySnapshot, id: string | null | undefined): string {
  if (id === 'owner') return 'You · Owner';
  const employee = state.employees.find(item => item.id === id);
  return employee ? employeeDisplayName(employee, state.employees) : 'Unassigned';
}
type CriterionEvidence = { criterion: string; rationale: string; sources: Array<{ type: 'artifact' | 'delivery' | 'release'; id: string; reviewId: string; identity: string }> };
function projectAcceptance(project: Project): string {
  const evidence: CriterionEvidence[] = project.completionEvidence || [];
  const completed = project.acceptance.filter(criterion => evidence.some(item => item.criterion === criterion)).length;
  return [`Acceptance: ${completed}/${project.acceptance.length} criteria evidenced · ${project.acceptance.length - completed} remaining`, ...project.acceptance.map(criterion => {
    const entry = evidence.find(item => item.criterion === criterion);
    return entry ? [`Completed: ${criterion}`, entry.rationale, ...entry.sources.map(source => `${source.type}: ${source.type === 'delivery' ? deliveryFor(project, source.id)?.prUrl || source.id : source.id}\nIdentity: ${source.identity}\nIndependent review: ${source.reviewId}`)].join('\n') : `Remaining: ${criterion}\nNo completion evidence recorded.`;
  })].join('\n\n');
}
function projectDeliveries(state: CompanySnapshot, project: Project): string {
  const deliveries = deliveriesFor(project);
  return deliveries.length ? deliveries.slice().reverse().map(delivery => {
    const blocked = state.assignments.filter(item => item.projectId === project.id && item.payload?.artifactId === delivery.artifactId && item.status === 'blocked' && item.blockedReason).at(-1);
    return [`${delivery.artifactId === project.delivery?.artifactId ? 'Latest' : 'Earlier'} delivery · ${delivery.state.replaceAll('_', ' ')}`, `PR #${delivery.prNumber}: ${delivery.prUrl}`, `Artifact: ${delivery.artifactId}`, `Reviewed source: ${delivery.identity}`, `Merge commit: ${delivery.mergeCommit || 'Not recorded'}`, `Default-branch head: ${delivery.defaultBranchHead || 'Not recorded'}`, delivery.deliveredAt && `Delivery recorded: ${delivery.deliveredAt}`, delivery.state === 'awaiting_checks' && 'Required GitHub checks and the reviewed-head merge are not yet confirmed.', delivery.remainingGate && `Remaining delivery requirement: ${delivery.remainingGate}`, delivery.state !== 'merged' && blocked && `Recorded delivery blocker: ${blocked.blockedReason}`].filter(Boolean).join('\n');
  }).join('\n\n') : 'No product delivery recorded.';
}
function artifactDetail(state: CompanySnapshot, artifact: Artifact): string {
  const imported = Object.hasOwn(artifact, 'sourcePullRequest') || Object.hasOwn(artifact, 'reviewWorkspace'), source = artifact.sourcePullRequest;
  return [`Artifact: ${artifact.summary}`, artifact.uri, `Identity: ${artifact.identity}`,
    imported ? `External pull request${source?.number ? ` #${source.number}` : ''} · PR author: ${source?.authorLogin || 'Not recorded'}\nImported by ${employeeName(state, artifact.employeeId)}. The source code retains its external authorship.\nSource PR: ${source?.url || 'Not recorded'}` : `By ${employeeName(state, artifact.employeeId)}`,
    `Artifact content: /api/v1/artifacts/${encodeURIComponent(artifact.id)}/content`].join('\n');
}
export function tuiRecords(state: CompanySnapshot, tab: number): Array<{ id: string; title: string; detail: string }> {
  switch (tab) {
    case 1: return state.products.map((product) => ({ id: product.id, title: `${product.name} · ${product.status}`, detail: [product.assessment || 'Assessment pending', `Priority reason: ${product.rationale || 'Not recorded'}`, `Repository: ${product.repository}`, `Goals:\n${narratives(product.goals)}`, `Roadmap:\n${narratives(product.roadmap)}`].join('\n\n') }));
    case 2: return state.projects.map((project) => ({ id: project.id, title: `${project.name} · ${project.status}`, detail: [project.outcome, projectAcceptance(project), `Supervisor: ${employeeName(state, project.supervisorId)}`, `Reason: ${project.rationale}`, projectDeliveries(state, project), ...state.assignments.filter((item) => item.projectId === project.id).map((item) => `${item.status}: ${item.title} — ${employeeName(state, item.employeeId)}\nDependencies: ${item.dependencies.join(', ') || 'None'}`), ...state.artifacts.filter((item) => item.projectId === project.id).map((item) => artifactDetail(state, item))].join('\n\n') }));
    case 3: return state.employees.map((employee) => ({ id: employee.id, title: `${employeeDisplayName(employee, state.employees)} · ${state.positions.find((position) => position.id === employee.positionId)?.title || 'Unassigned'}`, detail: [`${employee.badge} · ${employee.id} · ${employee.status}`, `Manager: ${employeeName(state, employee.homeManagerId)}`, `Model: ${employee.modelId}`, `Role v${employee.roleVersion}:\n${employee.role}`, ...state.assignments.filter((item) => item.employeeId === employee.id).map((item) => `${item.status}: ${item.title}`)].join('\n\n') }));
    case 4: return [...state.decisions].reverse().map((decision) => ({ id: decision.id, title: `${decision.subject} · ${decision.status}`, detail: [`By ${employeeName(state, decision.authorId)}`, decision.rationale, ...state.votes.filter((vote) => vote.decisionId === decision.id).map((vote) => `${vote.approve ? 'APPROVE' : 'DISSENT'} · ${employeeName(state, vote.employeeId)}: ${vote.rationale}`)].join('\n\n') }));
    case 5: return state.attention.filter((attention) => attention.status === 'open').map((attention) => ({ id: attention.id, title: `${attention.title} · ${attention.kind}`, detail: `${attention.detail}\n\nRequired action: ${attention.requiredAction || 'Inspect this request in the WebUI.'}\nAccountable employee: ${employeeName(state,attention.ownerId)}\nRecommendation: ${attention.recommendation??'Not recorded'}\nRecheck: ${attention.nextCheckAt??'Not recorded'}\nNotification: ${attention.notification?.status??'Not submitted'}\nRequest ID: ${attention.id}\nUse Command view or WebUI to record your action.` }));
    case 7: return state.departments.map(d=>({id:d.id,title:`${d.name} · ${d.status??'active'}`,detail:[d.charter??d.responsibilities,`Manager: ${employeeName(state,d.managerId)}`,`Employees: ${state.employees.filter(e=>e.departmentId===d.id&&e.status==='active').length}`,d.helpPolicy,...(d.standingDuties??[]).map((d:any)=>`${d.name} · every ${d.intervalHours} hours\n${d.instructions}`)].filter(Boolean).join('\n\n')}));
    case 8: return state.experiences.filter(e=>['requisition','candidate','skill-source'].includes(e.kind)).map(e=>({id:e.id,title:`${e.name??e.upstreamPath??state.positions.find(p=>p.id===e.positionId)?.title??e.kind} · ${e.status??'pinned'}`,detail:JSON.stringify(e,null,2)}));
    case 9: return state.experiences.filter(e=>e.kind==='workplace.channel'||e.kind==='workplace.event').map(e=>({id:e.id,title:`${e.name??e.title} · ${e.status??'channel'}`,detail:[e.purpose,e.fictional?'Fictional AI birthday/persona details; not human biography.':null,e.scheduledAt?`Scheduled: ${e.scheduledAt} · host ${employeeName(state,e.hostId)}`:null,JSON.stringify(e,null,2),...state.messages.filter(m=>e.kind==='workplace.channel'?m.channelId===e.id:m.eventId===e.id).map(m=>`${employeeName(state,m.senderId)} · ${m.createdAt} · run ${m.runId}\n${m.content}`)].filter(Boolean).join('\n\n')}));
    case 10: return state.assignments.filter(a=>!['completed','cancelled'].includes(a.status)&&a.kind!=='social').map(a=>({id:a.id,title:`${a.title} · ${a.status}`,detail:[`Accountable owner: ${employeeName(state,a.continuation?.ownerId??a.supervisorId)}`,a.blockedReason,a.continuation?`Next: ${a.continuation.action}\nRecheck: ${a.continuation.nextCheckAt}`:'Continuation not yet recorded',JSON.stringify(a.continuation??{},null,2)].filter(Boolean).join('\n\n')}));
    default: return [];
  }
}
function wrappedLines(text: string, width: number): string[] {
  return clean(text).split('\n').flatMap((line) => {
    if (!line) return [''];
    const lines: string[] = []; let rest = line;
    while (rest.length > width) { let cut = rest.lastIndexOf(' ', width); if (cut < Math.floor(width / 3)) cut = width; lines.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart(); }
    lines.push(rest); return lines;
  });
}
export function TerminalApp({ client }: { client: OwnerClient }) {
  const { exit } = useApp(); const { stdout } = useStdout();
  const [state, setState] = useState<CompanySnapshot>(); const [tab, setTab] = useState(0); const [selected, setSelected] = useState(0);
  const [commandDraft,setCommandDraft]=useState('');
  const [detail, setDetail] = useState(false); const [offset, setOffset] = useState(0); const [draft, setDraft] = useState('');
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [connected, setConnected] = useState(false); const [pending, setPending] = useState(false); const [confirmStop, setConfirmStop] = useState(false);
  const alive = useRef(true); const refreshing = useRef(false);
  const width = Math.max(24, (stdout.columns || 90) - 6);
  const composing=tab===6||tab===11,inputDraft=tab===11?commandDraft:draft,setInputDraft=tab===11?setCommandDraft:setDraft;
  const help = composing ? 'Enter send · Ctrl+U clear · Tab browse · Esc overview · Ctrl+C close' : 'Tab all views · 1–9 jump · ↑↓ browse · Enter details · Esc back · p pause · r resume · s stop · f refresh · q close';
  let navigationRows = 1; let navigationWidth = 0;
  for (const name of tabs) { const size = name.length + 2; if (navigationWidth && navigationWidth + size + 2 > width + 4) { navigationRows++; navigationWidth = 0; } navigationWidth += size + (navigationWidth ? 2 : 0); }
  const chromeRows = 3 + navigationRows + 1 + wrappedLines(help, width + 4).length + 1 + (error ? wrappedLines(error, width + 4).length : 0) + (notice ? wrappedLines(notice, width + 4).length : 0) + (pending ? 1 : 0) + (composing ? 3 : 0) + (tab === 0 || composing || detail ? 1 : 0);
  const height = Math.max(2, (stdout.rows || 30) - chromeRows - 1);
  const refresh = useCallback(async () => {
    if (refreshing.current) return; refreshing.current = true;
    try { const next = await client.state(AbortSignal.timeout(8000)); if (alive.current) { setState(next); setConnected(true); setError(''); } }
    catch (failure) { if (alive.current) { setConnected(false); setError(failure instanceof Error ? failure.message : 'Connection failed'); } }
    finally { refreshing.current = false; }
  }, [client]);
  useEffect(() => {
    alive.current = true; let controller: AbortController | undefined; let reconnect: NodeJS.Timeout | undefined;
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    const connect = async () => {
      controller = new AbortController();
      try { await client.events(() => { void refresh(); }, controller.signal); }
      catch { if (alive.current) setConnected(false); }
      if (alive.current) reconnect = setTimeout(() => { void refresh(); void connect(); }, 2500);
    };
    void connect();
    return () => { alive.current = false; clearInterval(timer); if (reconnect) clearTimeout(reconnect); controller?.abort(); };
  }, [client, refresh]);
  const control = async (action: 'pause' | 'resume' | 'stop') => { setPending(true); try { await client.control(action); setNotice(`Company ${action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'stopped'}.`); await refresh(); } catch (failure) { setNotice(failure instanceof Error ? failure.message : 'Control failed'); } finally { setPending(false); } };
  const send = async () => { if (!inputDraft.trim() || pending) return; setPending(true); try { if(tab===11){const command:unknown=JSON.parse(inputDraft);if(!command||typeof command!=='object'||Array.isArray(command)||typeof (command as {type?:unknown}).type!=='string')throw new Error('Command requires a JSON object containing type.');await client.request('command',command);}else await client.chat(inputDraft.trim()); setInputDraft(''); setNotice(tab===11?'Command saved.':'Message saved.'); await refresh(); } catch (failure) { setNotice(failure instanceof Error ? failure.message : 'Message failed'); } finally { setPending(false); } };
  const records = state ? tuiRecords(state, tab) : [];
  const activeRecord = records[Math.min(selected, Math.max(0, records.length - 1))];
  let body = '';
  if (state) {
    if (tab === 0) body = [`${state.company.name} · ${state.company.state}`, '', state.company.mandate, '', `Work: ${state.assignments.filter((item) => item.status === 'running').length} running · ${state.assignments.filter((item) => item.status === 'queued').length} queued · ${state.assignments.filter((item) => item.status === 'completed').length} completed`, `Inference: ${state.runs.filter((item) => item.status === 'running').length}/${state.policy.maxInference} slots · local only`, `Unapproved spending: $${state.policy.spendingLimit} · Owner attention: ${state.attention.filter((item) => item.status === 'open').length}`, '', 'CURRENT PRIORITIES', ...[...state.products].sort((a, b) => b.priority - a.priority).map((product) => `${product.name}: ${product.rationale || 'Leadership assessment pending'}`), '', 'CURRENT WORK', ...state.assignments.filter((item) => !['completed', 'cancelled'].includes(item.status)).map((item) => `${item.status}: ${item.title} (${employeeName(state, item.employeeId)})`)].join('\n');
    else if (tab===11) body='Owner command\n\nEnter a JSON company command. Server authority checks apply.\nExample: {"type":"workplace.configure","enabled":false}\n\nUse attention.acknowledge to mark a request seen; attention.resolve requires the actual completed prerequisite.\nCLI alternative: opencorp command <json>';
    else if (tab === 6) {
      const ceo = state.employees.find((employee) => employee.status === 'active' && state.positions.find((position) => position.id === employee.positionId)?.level === 'ceo');
      const messages = state.messages.filter((message) => !message.projectId && (message.senderId === ceo?.id || message.recipientId === ceo?.id));
      body = messages.length ? messages.slice(-20).map((message) => `${employeeName(state, message.senderId)} · ${new Date(message.createdAt).toLocaleTimeString()}\n${message.content}`).join('\n\n') : 'No CEO messages yet. Messages are optional; the company independently chooses work.';
    } else if (detail && activeRecord) body = `${activeRecord.title}\n\n${activeRecord.detail}`;
  }
  const lines = wrappedLines(body, width);
  const maxOffset = Math.max(0, lines.length - height);
  useEffect(() => { if (tab === 6) setOffset(maxOffset); }, [tab, state?.messages.length, maxOffset]);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }
    if (confirmStop) { if (input.toLowerCase() === 'y' && !pending) { setConfirmStop(false); void control('stop'); } else if (key.escape || input.toLowerCase() === 'n') setConfirmStop(false); return; }
    if (key.tab) { setTab((value) => (value + (key.shift ? tabs.length - 1 : 1)) % tabs.length); setSelected(0); setDetail(false); setOffset(0); setNotice(''); return; }
    if (key.escape) { if (composing) { setTab(0); setOffset(0); } else { setDetail(false); setOffset(0); } return; }
    if (composing) {
      if (key.return) { void send(); return; }
      if (key.backspace || key.delete) { setInputDraft((value) => Array.from(value).slice(0, -1).join('')); return; }
      if (key.upArrow) { setOffset((value) => Math.max(0, value - 1)); return; }
      if (key.downArrow) { setOffset((value) => Math.min(maxOffset, value + 1)); return; }
      if (key.ctrl && input === 'u') { setInputDraft(''); return; }
      if (!key.ctrl && !key.meta && input) setInputDraft((value) => (value + input.replace(/[\r\n]/g, ' ')).slice(0, 20000));
      return;
    }
    if (input === 'q') { exit(); return; }
    if (input === 'p' && !pending) { void control('pause'); return; }
    if (input === 'r' && !pending) { void control('resume'); return; }
    if (input === 's' && !pending) { setConfirmStop(true); return; }
    if (input === 'f') { void refresh(); return; }
    if (/^[1-9]$/.test(input)) { setTab(Number(input) - 1); setSelected(0); setDetail(false); setOffset(0); return; }
    if (key.return && activeRecord) { setDetail(true); setOffset(0); return; }
    if (key.upArrow || key.downArrow) {
      const direction = key.upArrow ? -1 : 1;
      if (tab === 0 || detail) setOffset((value) => Math.max(0, Math.min(maxOffset, value + direction)));
      else setSelected((value) => Math.max(0, Math.min(records.length - 1, value + direction)));
    }
    if (key.pageDown) setOffset((value) => Math.min(maxOffset, value + height));
    if (key.pageUp) setOffset((value) => Math.max(0, value - height));
  });
  const start = Math.min(offset, maxOffset);
  const listStart = Math.max(0, selected - height + 1);
  return <Box flexDirection="column" paddingX={1}>
    <Box justifyContent="space-between" borderStyle="single" borderColor="cyan" paddingX={1}><Text bold>OpenCorp · Owner terminal</Text><Text color={connected ? 'green' : 'yellow'}>{connected ? state?.company.state : 'reconnecting'}</Text></Box>
    <Box columnGap={2} rowGap={0} flexWrap="wrap" marginBottom={1}>{tabs.map((name, index) => <Text key={name} bold={tab === index} color={tab === index ? 'cyan' : 'gray'} inverse={tab === index}>{index + 1} {name}</Text>)}</Box>
    {error && <Text color="yellow">{clean(error)}</Text>}
    <Box height={height} flexDirection="column" overflow="hidden">
      {!state ? <Text color="gray">{error ? 'Waiting for service. Your selection and draft remain here.' : 'Loading company…'}</Text> : body ? lines.slice(start, start + height).map((line, index) => <Text key={index}>{line || ' '}</Text>) : records.length ? records.slice(listStart, listStart + height).map((record, index) => <Text key={record.id} color={selected === index + listStart ? 'cyan' : undefined} inverse={selected === index + listStart}>{selected === index + listStart ? '› ' : '  '}{clean(record.title)}</Text>) : <Text color="gray">{tab === 5 ? 'No Owner action required.' : 'No records yet. Leadership creates these as work requires.'}</Text>}
    </Box>
    {body && <Text color="gray">Lines {Math.min(start + 1, lines.length)}–{Math.min(start + height, lines.length)} of {lines.length} · ↑↓ scroll</Text>}
    {composing && <Box borderStyle="single" borderColor="cyan" paddingX={1}><Text>{tab===11?'JSON':'Message'}: {clean(inputDraft).slice(-Math.max(12, width - 12))}<Text inverse> </Text></Text></Box>}
    {confirmStop ? <Text color="yellow">Stop company and owned runtimes? Work is preserved. y stop · n cancel</Text> : <Text color="gray">{help}</Text>}
    {notice && <Text color="cyan">{clean(notice)}</Text>}{pending && <Text color="yellow">Saving command…</Text>}
    <Text color="gray">Closing this interface leaves the service running.</Text>
  </Box>;
}
export async function launchTui(client: OwnerClient): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The TUI needs an interactive terminal. Use opencorp status --json for scripts.');
  const app = render(<TerminalApp client={client}/>); await app.waitUntilExit();
}
