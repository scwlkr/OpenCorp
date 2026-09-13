import assert from 'node:assert/strict';
import { directFreeProvider } from '../src/core/inference-policy.js';
import { CompanyStore, instructionsHash } from '../src/storage/store.js';
import { localModelSelectionId } from '../src/runtime/ollama.js';
import type { RuntimeModel } from '../src/runtime/types.js';

/** Synthetic store setup shared with its no-inference regression. */
export function setupReasoningManagementFixture(store: CompanyStore, models: RuntimeModel[], model: RuntimeModel, workspace: string, existingReaderId?: string, existingManagerId?: string) {
  store.bootstrap();
  store.update('policy', store.policy.id, { allowedRepositories: [] });
  for (const item of models) store.put('models', { ...item, id: localModelSelectionId(item) });
  const owner = { kind: 'owner' } as const;
  if (!model.local) {
    const key=directFreeProvider(model.id)?'directFreeModels':'openRouterFreeModels',selected=store.policy[key]??[];
    if(!selected.includes(model.id))store.command(owner,{type:'policy.update',[key]:[...selected,model.id]});
  }
  const ceo = existingManagerId ? store.need('employees',existingManagerId) : store.list('employees').find(employee => store.level(employee.id) === 'ceo'); assert.ok(ceo);
  store.command(owner, { type: 'employee.model', employeeId: ceo.id, modelId: model.id, rationale: 'Disposable low-reasoning management qualification only.' });
  const position = existingReaderId ? undefined : store.command(owner, { type: 'position.create', title: 'Fixture reader', level: 'worker', responsibilities: 'Read explicitly assigned company records and report findings.' });
  const employee = existingReaderId ? store.need('employees',existingReaderId) : store.command(owner, { type: 'employee.hire', name: 'Synthetic fixture reader', positionId: position!.id, homeManagerId: ceo.id, modelId: model.id });
  const original = store.command(owner, { type: 'assignment.create', employeeId: employee.id, supervisorId: ceo.id, title: 'Inspect fixture department', kind: 'management', instructions: 'Inspect the relevant department and report its current responsibilities to your manager.', acceptance: ['The assigned department is identified and its actual responsibilities reported.'] });
  store.update('assignments', original.id, { status: 'blocked', blockedReason: 'Synthetic setup: the assignment omitted which department to inspect.', attempts: 1 });
  const failed = store.put('runs', { employeeId: employee.id, assignmentId: original.id, modelId: model.id, status: 'failed', attempt: 1, tokenRevoked: true, error: 'Synthetic fixture failure, not an actual prior inference: department identity was missing.' });
  const department = store.command(owner, { type: 'department.create', name: `Synthetic fixture records for ${ceo.id}`, managerId: ceo.id, responsibilities: 'Maintain clearly attributed fixture records for bounded management testing.' });
  const task = store.command(owner, { type: 'assignment.create', employeeId: ceo.id, title: 'Diagnose synthetic missing department instruction', kind: 'management', instructions: 'Inspect the original and retained failure, author a precise correction and retry only when justified.', acceptance: ['Actual current-run correction and retry or accurate blocked disposition is retained.'] });
  store.update('assignments', task.id, { schedulerKey: `fault:${failed.id}`, payload: { failedRunId: failed.id, failedAssignmentId: original.id, baselineModelId: model.id, baselineInstructionsHash: instructionsHash(original.instructions), baselineBlockedReason: store.need('assignments', original.id).blockedReason } });
  store.command(owner, { type: 'control', action: 'start' });
  const run = store.claimNext({ assignmentId: task.id, workspace }); assert.ok(run && store.faultContext(run.id));
  return { ceo, employee, original, failed, department, task, run };
}
