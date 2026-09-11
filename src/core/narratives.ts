import type { Employee } from './types.js';

export function employeeDisplayName(employee: Pick<Employee, 'id' | 'name' | 'badge'>, employees: ReadonlyArray<Pick<Employee, 'id' | 'name'>>): string {
  return employees.some(other => other.id !== employee.id && other.name === employee.name) ? `${employee.name} · ${employee.badge}` : employee.name;
}

export function describeNarrative(value: unknown): { title: string; rationale?: string; measure?: string; status?: string } {
  if (typeof value === 'string') return { title: value };
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const text = (...keys: string[]) => keys.map((key) => item[key]).find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return { title: text('outcome', 'title', 'name', 'goal', 'description') || 'Recorded objective', rationale: text('rationale'), measure: text('measure', 'successMeasure'), status: text('status') };
}
