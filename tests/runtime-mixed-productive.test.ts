import { afterEach,expect,it,vi } from 'vitest';
import { LocalRuntime } from '../src/runtime/index.js';
import { OwnedOllama } from '../src/runtime/ollama.js';
import { DirectFree } from '../src/runtime/direct-free.js';
afterEach(()=>vi.restoreAllMocks());
it('atomically keeps one exact local and remote binding, and releases only the canceled identity',async()=>{
 const local={id:'local-fixture',alias:'local-fixture',sourceAlias:'local-fixture',local:true,available:true,artifactIdentity:'a'.repeat(64),capabilities:['tools']},remote={id:'gemini:fixture',alias:'gemini:fixture',local:false,artifactIdentity:'b'.repeat(64)};
 vi.spyOn(OwnedOllama.prototype,'start').mockResolvedValue();vi.spyOn(OwnedOllama.prototype,'models').mockResolvedValue([local] as any);vi.spyOn(OwnedOllama.prototype,'prepareResidency').mockResolvedValue(0);vi.spyOn(DirectFree.prototype,'models').mockResolvedValue([remote] as any);vi.spyOn(DirectFree.prototype,'availability').mockResolvedValue(undefined);
 const runtime=new LocalRuntime({dataRoot:'/unused-mixed',resourceBudget:{maxConcurrentTurns:4,maxProductiveTurns:2,productiveArtifactIdentity:local.artifactIdentity,productiveRemoteModelId:remote.id,productiveRemoteArtifactIdentity:remote.artifactIdentity},directFree:{gemini:{modelIds:[remote.id],readCredentials:async()=>{throw new Error('No key in test');}}}});
 vi.spyOn((runtime as any).resources,'admit').mockReturnValue(()=>{});
 const entered:string[]=[];vi.spyOn(runtime as any,'run').mockImplementation(async(...args:any[])=>{const request=args[0],signal=args[2];entered.push(request.runId);return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
 const request=(id:string,modelId:string,controller:AbortController)=>({runId:id,employeeId:id,modelId,workspace:'/unused',system:'',prompt:'',signal:controller.signal,directFreeModels:[remote.id]});
 const a=new AbortController(),b=new AbortController();
 const first=runtime.execute(request('local-one',local.id,a)).catch(e=>e),second=runtime.execute(request('remote-one',remote.id,b)).catch(e=>e);
 await vi.waitFor(()=>expect(entered).toHaveLength(2));
 await expect(runtime.execute(request('local-two',local.id,new AbortController()))).rejects.toThrow('slot already occupied');
 await expect(runtime.execute(request('remote-two',remote.id,new AbortController()))).rejects.toThrow('slot already occupied');
 expect(entered).toHaveLength(2);a.abort(new Error('Cancel local'));await first;expect(runtime.status().activeRuns).toEqual(['remote-one']);
 const c=new AbortController(),third=runtime.execute(request('local-three',local.id,c)).catch(e=>e);await vi.waitFor(()=>expect(entered).toContain('local-three'));
 b.abort(new Error('Cancel remote'));c.abort(new Error('Cancel local'));await Promise.all([second,third]);expect(runtime.status().activeRuns).toEqual([]);expect((runtime as any).productiveBindings.size).toBe(0);
});
it('allows any authorized solo identity but never shares with an unqualified binding',()=>{
 const runtime=new LocalRuntime({dataRoot:'/unused'});Object.assign((runtime as any).resources.limits,{maxProductiveTurns:2,productiveArtifactIdentity:'local-pin',productiveRemoteModelId:'gemini:fixture',productiveRemoteArtifactIdentity:'remote-pin'});
 (runtime as any).reserveMixedProductive({runId:'solo'},{local:true,artifactIdentity:'other-local'});
 expect(()=>(runtime as any).reserveMixedProductive({runId:'remote'},{local:false,id:'gemini:fixture',artifactIdentity:'remote-pin'})).toThrow('binding');expect((runtime as any).productiveBindings.size).toBe(1);
});

it('retained mixed pins cannot permit two turns after productive limit returns to one',()=>{const runtime=new LocalRuntime({dataRoot:'/unused'});Object.assign((runtime as any).resources.limits,{maxProductiveTurns:1,productiveArtifactIdentity:'local-pin',productiveRemoteModelId:'gemini:fixture',productiveRemoteArtifactIdentity:'remote-pin'});(runtime as any).reserveMixedProductive({runId:'local'},{local:true,artifactIdentity:'local-pin'});expect(()=>(runtime as any).reserveMixedProductive({runId:'remote'},{local:false,id:'gemini:fixture',artifactIdentity:'remote-pin'})).toThrow('slot already occupied');});

import {productiveSharingAllowed} from '../src/core/inference-policy.js';
it('counts exact remote profiles and aggregate providers while preserving one local',()=>{
 const local={local:true,artifactIdentity:'a'.repeat(64)},a={local:false,provider:'gemini',id:'gemini:a',artifactIdentity:'b'.repeat(64)},b={...a,id:'gemini:b',artifactIdentity:'c'.repeat(64)},or={local:false,provider:'openrouter',id:'vendor/free:free',artifactIdentity:'d'.repeat(64)};
 const limits={maxProductiveTurns:5,productiveArtifactIdentity:local.artifactIdentity,productiveRemoteProfiles:[{modelId:a.id,artifactIdentity:a.artifactIdentity,maxConcurrentTurns:2},{modelId:b.id,artifactIdentity:b.artifactIdentity,maxConcurrentTurns:2},{modelId:or.id,artifactIdentity:or.artifactIdentity,maxConcurrentTurns:2}],productiveProviderCaps:[{provider:'gemini' as const,maxConcurrentTurns:2},{provider:'openrouter' as const,maxConcurrentTurns:2}]};
 expect(productiveSharingAllowed(or,[local,a,b,or],limits)).toBe(true);expect(productiveSharingAllowed(b,[local,a,a],limits)).toBe(false);expect(productiveSharingAllowed(local,[local],limits)).toBe(false);expect(productiveSharingAllowed({...a,artifactIdentity:'wrong'},[local],limits)).toBe(false);expect(productiveSharingAllowed({...a,provider:'groq'},[local],limits)).toBe(false);expect(productiveSharingAllowed(or,[local,a,b,or,or],limits)).toBe(false);expect(productiveSharingAllowed(or,[local],{...limits,maxProductiveTurns:1})).toBe(false);
});
it('holds five actual runtime admissions and cancellation releases only one remote slot',async()=>{
 const local={id:'local-fixture',alias:'local-fixture',sourceAlias:'local-fixture',local:true,available:true,artifactIdentity:'a'.repeat(64),capabilities:['tools']},remote={id:'gemini:fixture',alias:'gemini:fixture',provider:'gemini',local:false,artifactIdentity:'b'.repeat(64)};
 vi.spyOn(OwnedOllama.prototype,'start').mockResolvedValue();vi.spyOn(OwnedOllama.prototype,'models').mockResolvedValue([local] as any);vi.spyOn(OwnedOllama.prototype,'prepareResidency').mockResolvedValue(0);vi.spyOn(DirectFree.prototype,'models').mockResolvedValue([remote] as any);vi.spyOn(DirectFree.prototype,'availability').mockResolvedValue(undefined);
 const runtime=new LocalRuntime({dataRoot:'/unused-five',resourceBudget:{maxConcurrentTurns:5,maxProductiveTurns:5,productiveArtifactIdentity:local.artifactIdentity,productiveRemoteProfiles:[{modelId:remote.id,artifactIdentity:remote.artifactIdentity,maxConcurrentTurns:4}],productiveProviderCaps:[{provider:'gemini',maxConcurrentTurns:4}]},directFree:{gemini:{modelIds:[remote.id],readCredentials:async()=>{throw new Error('No key');}}}});vi.spyOn((runtime as any).resources,'admit').mockReturnValue(()=>{});const entered:string[]=[];vi.spyOn(runtime as any,'run').mockImplementation(async(...args:any[])=>{entered.push(args[0].runId);return new Promise((_resolve,reject)=>args[2].addEventListener('abort',()=>reject(args[2].reason),{once:true}));});
 const controllers=Array.from({length:6},()=>new AbortController()),request=(i:number)=>({runId:'five-'+i,employeeId:'employee-'+i,modelId:i===0?local.id:remote.id,workspace:'/unused',system:'',prompt:'',signal:controllers[i].signal,directFreeModels:[remote.id]});
 const work=[0,1,2,3,4].map(i=>runtime.execute(request(i)).catch(e=>e));await vi.waitFor(()=>expect(entered).toHaveLength(5));await expect(runtime.execute(request(5))).rejects.toThrow('slots occupied');controllers[1].abort();await work[1];expect(runtime.status().activeRuns).toHaveLength(4);const replacement=runtime.execute(request(5)).catch(e=>e);await vi.waitFor(()=>expect(entered).toHaveLength(6));controllers.forEach(c=>c.abort());await Promise.all([...work,replacement]);expect(runtime.status().activeRuns).toHaveLength(0);
});

import {directFreeProvider,validProductiveRemoteCapacity,DIRECT_FREE_ENDPOINTS} from '../src/core/inference-policy.js';
it('allows only the exact Z.ai free model and one aggregate Z.ai productive stream',()=>{
 expect(directFreeProvider('zai:glm-4.7-flash')).toBe('zai');expect(DIRECT_FREE_ENDPOINTS.zai).toBe('https://api.z.ai/api/paas/v4/chat/completions');for(const id of ['zai:glm-4.7','zai:glm-4.7-flashx','zai:glm-5'])expect(directFreeProvider(id)).toBeUndefined();
 const profiles=[{modelId:'zai:glm-4.7-flash',artifactIdentity:'a'.repeat(64),maxConcurrentTurns:1}];expect(validProductiveRemoteCapacity(profiles,[{provider:'zai',maxConcurrentTurns:1}])).toBe(true);expect(validProductiveRemoteCapacity(profiles,[{provider:'zai',maxConcurrentTurns:2}])).toBe(false);
});

it('keeps exact-target availability failures typed before a native worker starts',async()=>{
 const {ProviderAvailabilityError}=await import('../src/runtime/resource-budget.js'),id='gemini:target',unavailable=new ProviderAvailabilityError('gemini',new Date(Date.now()+60000).toISOString(),'Local budget exhausted');
 vi.spyOn(DirectFree.prototype,'availability').mockResolvedValue(undefined);
 vi.spyOn(DirectFree.prototype,'models').mockImplementation(async function(this:any){expect(this.selection).toEqual([id]);throw unavailable;});
 const runtime=new LocalRuntime({dataRoot:'/unused-gemini-race',directFree:{gemini:{modelIds:[id,'gemini:sibling'],readCredentials:async()=>{throw new Error('No credential read in mocked admission');}}}}),run=vi.spyOn(runtime as any,'run');
 await expect(runtime.execute({runId:'race',employeeId:'employee',modelId:id,directFreeModels:[id],workspace:'/unused',system:'',prompt:''})).rejects.toBe(unavailable);expect(run).not.toHaveBeenCalled();expect(runtime.status().activeRuns).toHaveLength(0);
});
