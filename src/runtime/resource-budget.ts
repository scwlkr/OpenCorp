import { directFreeProvider, validOpenRouterFreeId, validProductiveRemoteCapacity, productiveCapacity } from '../core/inference-policy.js';
import { freemem, totalmem, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { LocalModel, RuntimeOptions } from './types.js';

const GiB = 1024 ** 3;
export class ResourceAdmissionError extends Error {
  constructor(message: string) { super(message); this.name = 'ResourceAdmissionError'; }
}
export class ProviderAvailabilityError extends Error {
 constructor(readonly provider:string,readonly retryAt:string,reason:string,readonly budgetScope?:string,readonly modelId?:string){super(reason);this.name='ProviderAvailabilityError';}
}
export class ProviderCooldownError extends ProviderAvailabilityError {
 constructor(provider:string,retryAt:string){super(provider,retryAt,`${provider} provider cooldown active; retry after ${retryAt}`);this.name='ProviderCooldownError';}
}
export interface HostMemory { free: number; total: number; available?: number; reclaimable?: number; pressure?: 'normal' | 'elevated'; measurement?: string }
/** File-backed cache can be evicted even while pages remain on the active queue after a model unload.
 * vm_stat cannot distinguish every dirty file-backed page: this is an estimate, guarded by
 * kernel pressure, 20% total-memory headroom, and the explicit free-memory reserve.
 * Anonymous/wired/compressed memory is not added to available capacity.
 * https://developer.apple.com/videos/play/wwdc2022/10106/ */
export function macMemorySnapshot(vmStat: string, pressureLevel: number, total: number): HostMemory {
  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (name: string) => Number(vmStat.match(new RegExp(`^${name}:\\s+(\\d+)\\.`, 'm'))?.[1]);
  const free = pages('Pages free') * pageSize;
  const fileBacked = pages('File-backed pages');
  if (![pageSize, free, fileBacked, total].every(Number.isFinite) || pageSize <= 0 || total <= 0) throw new Error('Invalid macOS memory observation');
  const reclaimable = Math.max(0, fileBacked) * pageSize;
  return { free, total, reclaimable, available: Math.min(total, free + reclaimable), pressure: pressureLevel === 1 ? 'normal' : 'elevated', measurement: 'estimated free plus file-backed cache (active or inactive); kernel pressure' };
}
export function observeHostMemory(): HostMemory {
  const fallback = { free: freemem(), total: totalmem() };
  if (platform() !== 'darwin') return fallback;
  try {
    return macMemorySnapshot(execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 1000 }),
      Number(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8', timeout: 1000 }).trim()), fallback.total);
  } catch { return { ...fallback, measurement: 'physical free memory fallback' }; }
}

export function resourceLimits(options: RuntimeOptions['resourceBudget'] = {}) {
  const limits = { maxConcurrentTurns: options.maxConcurrentTurns ?? 1, maxProductiveTurns: options.maxProductiveTurns ?? 1, productiveArtifactIdentity: options.productiveArtifactIdentity, productiveRemoteModelId:options.productiveRemoteModelId, productiveRemoteArtifactIdentity:options.productiveRemoteArtifactIdentity, productiveRemoteProfiles:options.productiveRemoteProfiles, productiveProviderCaps:options.productiveProviderCaps, maxSocialTurns: options.maxSocialTurns ?? 1,
    maxLoadedModels: options.maxLoadedModels ?? 1, minFreeMemoryBytes: options.minFreeMemoryBytes ?? 2 * GiB };
  for (const [key, maximum] of [['maxProductiveTurns', 5], ['maxConcurrentTurns', 11], ['maxSocialTurns', 10], ['maxLoadedModels', 2]] as const) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) throw new Error(`Invalid resource limit: ${key}`);
  }
  if (limits.maxProductiveTurns > limits.maxConcurrentTurns || (limits.maxProductiveTurns > 1 && !/^[a-f0-9]{64}$/.test(limits.productiveArtifactIdentity ?? ''))) throw new Error('Concurrent productive turns require enough slots and an exact artifact identity');
  if((limits.productiveRemoteModelId!==undefined||limits.productiveRemoteArtifactIdentity!==undefined)&&(!limits.productiveRemoteModelId||!directFreeProvider(limits.productiveRemoteModelId)&&!validOpenRouterFreeId(limits.productiveRemoteModelId)||!/^[a-f0-9]{64}$/.test(limits.productiveRemoteArtifactIdentity??'')))throw new Error('Mixed productive turns require an exact free remote model and artifact identity');
  if((limits.productiveRemoteProfiles!==undefined||limits.productiveProviderCaps!==undefined)&&(!validProductiveRemoteCapacity(limits.productiveRemoteProfiles,limits.productiveProviderCaps)||limits.productiveRemoteModelId))throw new Error('Invalid qualified remote productive capacity');
  if(limits.productiveRemoteProfiles&&limits.productiveProviderCaps&&limits.maxProductiveTurns>productiveCapacity(limits.productiveRemoteProfiles,limits.productiveProviderCaps))throw new Error('Productive limit exceeds exact remote capacities');
  if(limits.maxProductiveTurns>2&&!limits.productiveRemoteProfiles)throw new Error('More than two productive turns require qualified remote capacities');
  if (!Number.isSafeInteger(limits.minFreeMemoryBytes) || limits.minFreeMemoryBytes < 0) throw new Error('Invalid free-memory reserve');
  return limits;
}

/** Admission estimates are conservative guards, never claims of qualified parallelism. */
export class ResourceBudget {
  readonly limits;
  private admittedFreeMemory = 0;
  private readonly weightReservations = new Map<string, number>();
  private readonly primaryContextReservations = new Map<string, number>();
  private readonly active = new Map<string, { model: LocalModel; workload: 'productive' | 'social'; primary: boolean; reservation: number }>();
  constructor(options?: RuntimeOptions['resourceBudget'], private readonly memory: () => HostMemory = observeHostMemory) {
    this.limits = resourceLimits(options);
  }
  admit(runId: string, model: LocalModel, workload: 'productive' | 'social' = 'productive', residentBytes = 0, pool?: 'primary' | 'micro'): () => void {
    if (this.active.has(runId)) throw new Error('Duplicate active runtime run ID');
    if (!model.artifactIdentity || !Number.isFinite(model.size) || model.size <= 0 || !Number.isSafeInteger(model.contextTokens) || model.contextTokens <= 0) throw new Error('Invalid local model resource metadata');
    const entries = [...this.active.values()];
    if (entries.length >= this.limits.maxConcurrentTurns) throw new ResourceAdmissionError('Local resource slots occupied; retain assignment in the durable queue');
    // An enabled concurrent workplace leaves at least one turn available to productive work.
    const socialLimit = Math.min(this.limits.maxSocialTurns, Math.max(1, this.limits.maxConcurrentTurns - 1));
    if (workload === 'social' && entries.filter(entry => entry.workload === 'social').length >= socialLimit) throw new ResourceAdmissionError('Productive compute reserve prevents social admission');
    const models = new Map(entries.map(entry => [entry.model.artifactIdentity, entry.model]));
    models.set(model.artifactIdentity, model);
    if (models.size > this.limits.maxLoadedModels) throw new ResourceAdmissionError('Local model residency budget occupied');
    const primary = pool ? pool === 'primary' : !model.id?.startsWith('micro-');
    const primaryIdentities = new Set(entries.filter(entry => entry.primary).map(entry => entry.model.artifactIdentity));
    if (primary) primaryIdentities.add(model.artifactIdentity);
    if ((this.limits.maxProductiveTurns === 2 || this.limits.productiveRemoteProfiles) && primaryIdentities.size > 1) throw new ResourceAdmissionError('Owned primary model profile occupied');
    const productive = entries.filter(entry => entry.workload === 'productive');
    if((this.limits.productiveRemoteModelId||this.limits.productiveRemoteProfiles)&&workload==='productive'&&productive.length)throw new ResourceAdmissionError('Mixed productive qualification permits only one local productive turn');
    const sharing = !this.limits.productiveRemoteModelId && !this.limits.productiveRemoteProfiles && workload === 'productive' && this.limits.maxProductiveTurns === 2 && model.artifactIdentity === this.limits.productiveArtifactIdentity;
    if (this.limits.maxProductiveTurns === 2 && productive.length && workload === 'productive' && (!sharing || productive.length >= 2 || productive.some(entry => entry.model.artifactIdentity !== model.artifactIdentity))) throw new ResourceAdmissionError('Strong-model productive compute slot occupied');
    if (model.size > 6 * GiB && entries.some(entry => entry.model.size > 6 * GiB && (!sharing || entry.model.artifactIdentity !== model.artifactIdentity))) throw new ResourceAdmissionError('Strong-model compute slot occupied');
    const memory = this.memory();
    const available = memory.available ?? memory.free;
    if (!entries.length) this.admittedFreeMemory = available;
    const contextBytes = (item: LocalModel) => item.contextTokens * 65536 + 256 * 1024 ** 2;
    const preallocatePrimary = this.limits.maxProductiveTurns === 2 && !this.limits.productiveRemoteModelId && !this.limits.productiveRemoteProfiles;
    const contextEstimate = preallocatePrimary
      ? [...models.values()].filter(item => primaryIdentities.has(item.artifactIdentity)).reduce((sum, item) => sum + 2 * contextBytes(item), 0) + [...entries.map(entry => entry.model), model].filter(item => !primaryIdentities.has(item.artifactIdentity)).reduce((sum, item) => sum + contextBytes(item), 0)
      : [...entries.map(entry => entry.model), model].reduce((sum, item) => sum + contextBytes(item), 0);
    const weights = [...models.values()].reduce((sum, item) => sum + item.size * 1.2, 0);
    if (!Number.isFinite(residentBytes) || residentBytes < 0) throw new Error('Invalid observed model residency');
    const newWeights = entries.some(entry => entry.model.artifactIdentity === model.artifactIdentity) ? 0 : Math.max(0, model.size * 1.2 - residentBytes);
    const contextAllocation = preallocatePrimary && primary ? (this.primaryContextReservations.has(model.artifactIdentity) ? 0 : 2 * contextBytes(model)) : contextBytes(model);
    const newAllocation = newWeights + contextAllocation;
    const pendingAllocation = [...this.weightReservations.values()].reduce((sum, bytes) => sum + bytes, 0)
      + [...this.primaryContextReservations.values()].reduce((sum, bytes) => sum + bytes, 0)
      + entries.reduce((sum, entry) => sum + entry.reservation, 0) + newAllocation;
    if (memory.pressure === 'elevated' || !Number.isFinite(available) || !Number.isFinite(memory.total) || available < newAllocation + this.limits.minFreeMemoryBytes || pendingAllocation + this.limits.minFreeMemoryBytes > this.admittedFreeMemory || weights + contextEstimate + this.limits.minFreeMemoryBytes > memory.total * 0.8) {
      throw new ResourceAdmissionError(`Observed host memory/resource estimate refuses local admission: ${JSON.stringify({ memory, available,
        newAllocation, residentBytes, newWeights, contextAllocation, pendingAllocation, admissionBaseline: this.admittedFreeMemory,
        estimatedTotalAllocation: weights + contextEstimate, totalAllocationLimit: memory.total * 0.8, reserve: this.limits.minFreeMemoryBytes })}`);
    }
    if (!this.weightReservations.has(model.artifactIdentity)) this.weightReservations.set(model.artifactIdentity, newWeights);
    if (preallocatePrimary && primary && !this.primaryContextReservations.has(model.artifactIdentity)) this.primaryContextReservations.set(model.artifactIdentity, contextAllocation);
    this.active.set(runId, { model, workload, primary, reservation: preallocatePrimary && primary ? 0 : contextAllocation });
    let released = false;
    return () => {
      if (released) return; released = true;
      this.active.delete(runId);
      if (![...this.active.values()].some(entry => entry.model.artifactIdentity === model.artifactIdentity)) { this.weightReservations.delete(model.artifactIdentity); this.primaryContextReservations.delete(model.artifactIdentity); }
    };
  }
  status() { return { ...this.limits, activeTurns: this.active.size, activeSocialTurns: [...this.active.values()].filter(entry => entry.workload === 'social').length,
    hostMemory: this.memory(), qualification: 'configured limits require measured trials' }; }
}
