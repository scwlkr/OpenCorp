import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { CorporateBroker } from '../src/tools/broker.js';
import { setupReasoningManagementFixture } from '../scripts/qwen-reasoning-management-fixture.js';
import type { RuntimeModel } from '../src/runtime/types.js';

it.each([false, true])('claims a genuinely supervised trusted diagnosis before inference and permits exact correction (remote=%s)', async remote => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-management-setup-'));
  const store = new CompanyStore(root);
  const localModel = { id: 'qwen-low-reasoning-48k', name: 'Synthetic model metadata only', alias: 'fixture', sourceAlias: 'fixture', provider: 'ollama', local: true, available: true, artifactIdentity: 'fixture-only', manifestDigest: 'fixture', templateDigest: 'fixture', parametersDigest: 'fixture', contextTokens: 49152, size: 1, sizeClass: 'large', capabilities: ['tools'], inferenceProfile: { id: 'qwen-low-reasoning-v1', reasoningEffort: 'low' } };
  const model: RuntimeModel = remote ? { ...localModel, id: 'vendor/model:free', alias: 'vendor/model:free', sourceAlias: 'vendor/model:free', provider: 'openrouter', local: false, sizeClass: 'remote', freeOnly: true, endpoint: 'https://openrouter.ai/api/v1/chat/completions', pricing: { prompt: '0', completion: '0' }, pricingVerifiedAt: new Date().toISOString(), providers: ['vendor'], artifactIdentity: 'a'.repeat(64), contextTokens: 32768 } as RuntimeModel : localModel as RuntimeModel;
  const broker = new CorporateBroker(store, root);
  try {
    const { ceo, employee, original, failed, task, run, department } = setupReasoningManagementFixture(store, [model], model, root);
    expect(original.supervisorId).toBe(ceo.id);
    expect(original.employeeId).toBe(employee.id);
    expect(store.faultContext(run.id)).toMatchObject({ diagnosis: { id: task.id }, failedRun: { id: failed.id }, assignment: { id: original.id } });
    store.bindSession(run.id, 'fixture-session', root);
    const actor = { kind: 'employee', employeeId: ceo.id, runId: run.id, policyRevision: store.policy.revision } as const;
    expect(broker.toolsFor(actor).map(tool => tool.name)).toContain('revise_and_retry_assignment');
    expect(store.need('assignments', original.id).status).toBe('blocked');
    const args = { instructions: `Inspect department ${department.id} and send its actual responsibilities to your manager.`, rationale: 'Synthetic unit test supplies the missing department identity.' };
    await broker.call(actor, 'revise_and_retry_assignment', args);
    const revised = store.need('assignments', original.id);
    expect(revised.status).toBe('queued');
    expect(revised.acceptance).toEqual(original.acceptance);
    expect(revised.faultCorrections.at(-1)).toMatchObject({ runId: run.id, failedRunId: failed.id, instructionsChanged: true });
    expect(revised.retryDecisions.at(-1).runId).toBe(run.id);
  } finally { await broker.cancel(); store.close(); await rm(root, { recursive: true, force: true }); }
});
it('reuses an existing copied reader without creating a position or employee',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qwen-existing-reader-')),store=new CompanyStore(root);store.bootstrap();
 const model={id:'local-fixture',name:'Local fixture',alias:'local-fixture',sourceAlias:'local-fixture',provider:'ollama',local:true,available:true,artifactIdentity:'a'.repeat(64),contextTokens:49152,size:1,capabilities:['tools']} as RuntimeModel;
 try{store.put('models',model);const owner={kind:'owner'} as const,ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 const position=store.command(owner,{type:'position.create',title:'Copied fixture reader',level:'worker',responsibilities:'Fixture'}),reader=store.command(owner,{type:'employee.hire',name:'Existing fixture identity',positionId:position.id,homeManagerId:ceo.id,modelId:model.id});
 const employees=store.list('employees').length,positions=store.list('positions').length;
 const fixture=setupReasoningManagementFixture(store,[model],model,root,reader.id);expect(fixture.employee.id).toBe(reader.id);expect(store.list('employees')).toHaveLength(employees);expect(store.list('positions')).toHaveLength(positions);expect(store.faultContext(fixture.run.id)).toBeTruthy();
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
it('claims four independent diagnoses with existing managers and a shared inactive reader',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mixed-four-fixtures-')),store=new CompanyStore(root);store.bootstrap();
 const local={id:'local-fixture',name:'Local fixture',alias:'local-fixture',sourceAlias:'local-fixture',provider:'ollama',local:true,available:true,artifactIdentity:'a'.repeat(64),contextTokens:49152,size:1,capabilities:['tools']} as RuntimeModel;
 const remote={...local,id:'vendor/model:free',name:'Remote fixture',provider:'openrouter',local:false,size:0,sizeClass:'remote',freeOnly:true,endpoint:'https://openrouter.ai/api/v1/chat/completions',pricing:{prompt:'0',completion:'0'},pricingVerifiedAt:new Date().toISOString(),providers:['vendor'],artifactIdentity:'b'.repeat(64),contextTokens:32768} as RuntimeModel;
 try{const owner={kind:'owner'} as const;store.put('models',local);store.put('models',remote);
 store.command(owner,{type:'policy.update',openRouterFreeModels:[remote.id],maxInference:5,maxProductiveTurns:5,concurrencyQualification:{passed:true,stableMaxInference:5,largePlusSmall:true,evidence:'Unit fixture only'},productiveConcurrencyQualification:{passed:true,mode:'local-remotes',stableMaxProductiveTurns:5,artifactIdentity:local.artifactIdentity,remoteProfiles:[{modelId:remote.id,artifactIdentity:remote.artifactIdentity,maxConcurrentTurns:4}],providerCaps:[{provider:'openrouter',maxConcurrentTurns:4}],evidence:'Unit fixture only'}});
 const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 const make=(name:string,level:'lead'|'worker')=>{const position=store.command(owner,{type:'position.create',title:name,level,responsibilities:'Isolated unit fixture'});return store.command(owner,{type:'employee.hire',name,positionId:position.id,homeManagerId:ceo.id,modelId:local.id});};
 const reader=make('Existing reader','worker'),managers=Array.from({length:4},(_,i)=>make(`Existing manager ${i}`,'lead')),count=store.list('employees').length;
 const fixtures=managers.map(manager=>setupReasoningManagementFixture(store,[local,remote],remote,root,reader.id,manager.id));
 expect(new Set(fixtures.map(f=>f.department.name)).size).toBe(4);expect(new Set(fixtures.map(f=>f.department.id)).size).toBe(4);for(const [index,fixture]of fixtures.entries())expect(fixture.department.managerId).toBe(managers[index].id);
 expect(new Set(fixtures.map(f=>f.run.employeeId)).size).toBe(4);expect(new Set(fixtures.map(f=>f.original.id)).size).toBe(4);expect(store.list('employees')).toHaveLength(count);
 const broker=new CorporateBroker(store,root);
 for(const [index,fixture]of fixtures.entries()){store.bindSession(fixture.run.id,`fixture-${index}`,root);const actor=broker.actor(fixture.run.id,broker.mint(store.need('runs',fixture.run.id)));expect(actor.kind==='employee'&&actor.policyRevision).toBe(store.policy.revision);expect(broker.toolsFor(actor).map(t=>t.name)).toContain('revise_and_retry_assignment');expect(fixture.original.supervisorId).toBe(managers[index].id);expect(store.faultContext(fixture.run.id)?.assignment.id).toBe(fixture.original.id);}
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
