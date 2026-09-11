import { createHash } from 'node:crypto';
import type { CompanySnapshot, EmployeeRun } from './types.js';

/** Exact pinned OpenCode 1.18.30 max-steps prompt, not phrase-based output filtering.
 * https://github.com/anomalyco/opencode/blob/v1.18.30/packages/core/src/session/runner/max-steps.ts */
export function isNativeStepLimitProtocol(text: unknown, completion: unknown): boolean {
  if (typeof text !== 'string' || !completion || typeof completion !== 'object') return false;
  const limit = (completion as { nativeStepLimit?: { limit?: unknown; request?: unknown; toolEnabledSteps?: unknown } }).nativeStepLimit;
  return limit?.limit === 32 && Number.isInteger(limit.request) && Number(limit.request) >= 1 && Number(limit.request) <= 36
    && Number.isInteger(limit.toolEnabledSteps) && Number(limit.toolEnabledSteps) >= 1 && Number(limit.toolEnabledSteps) <= 32
    && createHash('sha256').update(text).digest('hex') === 'a22542c356f74bfe3f8edc3f2251f6d5b3ee2e21746040eb602fa57283397404';
}

/** Omit confirmed protocol copies from discussion/learning views. Raw records,
 * native messages, run text and checkpoint events remain available as evidence. */
export function employeeNarrativeProjection(state: Pick<CompanySnapshot, 'runs' | 'assignments' | 'messages' | 'experiences'>) {
  const runs = new Map(state.runs.map(run => [run.id, run]));
  const assignments = new Map(state.assignments.map(assignment => [assignment.id, assignment]));
  const protocolRun = (id: unknown): EmployeeRun | undefined => {
    const run = typeof id === 'string' ? runs.get(id) : undefined;
    return run && isNativeStepLimitProtocol(run.text, run.runtimeCompletion) ? run : undefined;
  };
  return {
    messages: state.messages.filter(message => {
      const run = protocolRun(message.runId);
      return !(run && message.senderId === run.employeeId && message.content === run.text
        && message.projectId === assignments.get(run.assignmentId)?.projectId);
    }),
    experiences: state.experiences.filter(experience => {
      const run = protocolRun(experience.runId), assignment = run ? assignments.get(run.assignmentId) : undefined;
      return !(run && assignment && experience.employeeId === run.employeeId && experience.authorId === run.employeeId
        && experience.source === `run:${run.id}` && experience.summary === `${assignment.title}: ${run.text}`);
    }),
  };
}
