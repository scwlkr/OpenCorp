import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CompanyStore} from '../src/storage/store.js';
import {ownerApp,workerApp} from '../src/server/app.js';
import {CorporateBroker} from '../src/tools/broker.js';
import {assertFreeWorkflow} from '../src/tools/github.js';
import type {LocalRuntime} from '../src/runtime/index.js';
import type {Scheduler} from '../src/scheduler/scheduler.js';
import {preferredOwnerPort} from '../src/server/paths.js';
const roots:string[]=[],stores:CompanyStore[]=[];afterEach(()=>{stores.splice(0).forEach(s=>s.close());roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});
function setup(){const root=mkdtempSync(join(tmpdir(),'opencorp-api-'));roots.push(root);const store=new CompanyStore(root);stores.push(store);store.bootstrap();const pause=vi.fn(async()=>{}),start=vi.fn(),configureResources=vi.fn(async()=>{});const scheduler={pause,start,configureResources} as unknown as Scheduler;const installMicroModels=vi.fn(async(_ids?:unknown)=>[]);const runtime={installMicroModels,status:()=>({started:false,activeRuns:[],ollama:{running:false},inferenceSlots:1})} as unknown as LocalRuntime;const broker=new CorporateBroker(store,root);const app=ownerApp({store,runtime,broker,scheduler,getUrl:()=> 'http://127.0.0.1:4310'});const token=readFileSync(join(root,'owner-token'),'utf8');const request=(path:string,init:RequestInit={})=>app.request(`http://127.0.0.1:4310${path}`,{...init,headers:{host:'127.0.0.1:4310',authorization:`Bearer ${token}`,...init.headers}});return {runtime,store,broker,app,request,pause,start,configureResources,root,installMicroModels};}
describe('Owner and scoped worker boundaries',()=>{
 it('retains an alternate Owner port across daemon restarts',()=>{const root=mkdtempSync(join(tmpdir(),'opencorp-discovery-'));roots.push(root);writeFileSync(join(root,'discovery.json'),JSON.stringify({url:'http://127.0.0.1:48317'}));expect(preferredOwnerPort(root)).toBe(48317);expect(preferredOwnerPort(root,'4312')).toBe(4312);expect(preferredOwnerPort(root,'0')).toBe(0);expect(()=>preferredOwnerPort(root,'70000')).toThrow();writeFileSync(join(root,'discovery.json'),JSON.stringify({url:'https://outside.example:7777'}));expect(preferredOwnerPort(root)).toBe(4310);});
 it('rejects missing credentials, hostile origin/host, worker credentials and unknown controls',async()=>{const {request}=setup();expect((await request('/api/v1/state',{headers:{authorization:''}})).status).toBe(401);expect((await request('/api/v1/state',{headers:{origin:'https://attacker.example'}})).status).toBe(403);expect((await request('/api/v1/state',{headers:{host:'attacker.example'}})).status).toBe(403);expect((await request('/api/v1/events',{headers:{authorization:'Bearer worker-token'}})).status).toBe(401);expect((await request('/api/v1/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'destroy'})})).status).toBe(400);});
 it('uses one-time login and stable HttpOnly cookie; persists pause and invokes cancellation',async()=>{const {request,app,store,pause}=setup();const session=await (await request('/api/v1/session',{method:'POST'})).json();const login=await app.request(session.url,{headers:{host:'127.0.0.1:4310'}});const cookie=login.headers.get('set-cookie')!;expect(cookie).toContain('HttpOnly');expect(cookie).toContain('SameSite=Strict');expect((await app.request(session.url,{headers:{host:'127.0.0.1:4310'}})).status).toBe(401);expect((await request('/api/v1/state',{headers:{authorization:'',cookie:cookie.split(';')[0]}})).status).toBe(200);await request('/api/v1/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'pause'})});expect(store.company.state).toBe('paused');expect(pause).toHaveBeenCalledWith(false);});
 it('stores Owner chat in same backend and queues an attributed reply',async()=>{const {request,store}=setup();const result=await request('/api/v1/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:'Explain current blockers.'})});expect(result.status).toBe(200);expect(store.list('messages')[0].senderId).toBe('owner');const assignment=store.list('assignments')[0];expect(assignment.kind).toBe('conversation');expect(assignment.instructions).toContain('final response');expect(assignment.instructions).toContain('automatically persists');expect(assignment.instructions).toContain('when the request needs them');expect(assignment.acceptance).toEqual(['Answer the actual Owner message; a brief acknowledgment suffices when that is all the Owner requested.']);const spec=await(await request('/api/v1/openapi.json')).json();expect(spec.paths['/api/v1/control']).toBeDefined();});
 it('requires exact session binding and revokes late worker responses after pause',async()=>{const {store,broker}=setup();const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;store.put('models',{id:ceo.modelId,name:ceo.modelId,artifactIdentity:'local-fixture',local:true,available:true,capabilities:['tools']});store.command({kind:'owner'},{type:'control',action:'start'});const assignment=store.command({kind:'owner'},{type:'assignment.create',employeeId:ceo.id,title:'Controlled policy fixture',instructions:'Fixture',acceptance:['Persist'],kind:'management'});const run=store.claimNext({assignmentId:assignment.id})!;const token=broker.mint(run);store.bindSession(run.id,'bound-session');const app=workerApp(broker,()=> '127.0.0.1:4320');const call=(session='bound-session')=>app.request(`http://127.0.0.1:4320/mcp/${run.id}`,{method:'POST',headers:{host:'127.0.0.1:4320',authorization:`Bearer ${token}`,'content-type':'application/json','x-opencorp-session':session},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'company_command',arguments:{command:{type:'product.assess',productId:store.list('products')[0].id,assessment:'Fixture observation',rationale:'Controlled test'}}}})});expect((await call('other')).status).toBe(403);expect((await call()).status).toBe(200);store.command({kind:'owner'},{type:'control',action:'pause'});expect((await call()).status).toBe(403);});
});
describe('$0 workflow publication policy',()=>{it('permits known public standard runners and rejects larger runners, reusable jobs and metered scripts',()=>{const wf=(job:string)=>`name: CI\non: push\njobs:\n  test:\n${job}`;expect(()=>assertFreeWorkflow(wf('    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v6\n      - run: make test'))).not.toThrow();for(const job of ['    runs-on: ubuntu-latest-16-cores\n    steps:\n      - run: make test','    uses: other/repo/.github/workflows/ci.yml@main','    runs-on: macos-15-large\n    steps:\n      - run: make test','    runs-on: ubuntu-latest\n    steps:\n      - run: vercel deploy'])expect(()=>assertFreeWorkflow(wf(job))).toThrow(/charge|runner|workflow|provider/i);});});

it('applies an authenticated policy change through scheduler resource reconfiguration',async()=>{
 const {request,store,configureResources,pause}=setup();const revision=store.policy.revision;
 const result=await request('/api/v1/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'policy.update',maxInference:1})});
 expect(result.status).toBe(200);expect(store.policy.revision).toBe(revision+1);expect(configureResources).toHaveBeenCalledTimes(1);expect(pause).not.toHaveBeenCalled();
 const denied=await request('/api/v1/command',{method:'POST',headers:{'content-type':'application/json',authorization:''},body:JSON.stringify({type:'policy.update',maxInference:1})});
 expect(denied.status).toBe(401);expect(configureResources).toHaveBeenCalledTimes(1);
});

it('keeps micro installation Owner-only and paused with explicit optional candidate selection',async()=>{
 const {request,store,installMicroModels}=setup();store.command({kind:'owner'},{type:'control',action:'pause'});
 expect((await request('/api/v1/models/micro',{method:'POST'})).status).toBe(200);expect(installMicroModels).toHaveBeenLastCalledWith(undefined);
 expect((await request('/api/v1/models/micro',{method:'POST',body:JSON.stringify({modelIds:['micro-4']})})).status).toBe(200);expect(installMicroModels).toHaveBeenLastCalledWith(['micro-4']);
 const calls=installMicroModels.mock.calls.length;
 for(const body of [{modelIds:['small']},{modelIds:['qwen3:4b']},{modelIds:['micro-4'],downloadAll:true}])expect((await request('/api/v1/models/micro',{method:'POST',body:JSON.stringify(body)})).status).toBeGreaterThanOrEqual(400);
 expect((await request('/api/v1/models/micro',{method:'POST',headers:{authorization:''}})).status).toBe(401);
 store.command({kind:'owner'},{type:'control',action:'start'});expect((await request('/api/v1/models/micro',{method:'POST',body:JSON.stringify({modelIds:['micro-4']})})).status).toBeGreaterThanOrEqual(400);
 expect(installMicroModels).toHaveBeenCalledTimes(calls);
});

it('provider health retains failed tests and later actual failures without raw diagnostics',async()=>{const {request,store,runtime}=setup() as any;runtime.providerStatus=async()=>[{id:'groq',configured:true,health:'unknown',reason:'Not tested',modelIds:['groq:fixture'],activeRuns:0,audit:{status:'owner-attested'},quota:{status:'unknown'},testing:false}];runtime.testProvider=async()=>({provider:'groq',modelId:'groq:fixture',status:'passed',finishedAt:new Date(Date.now()-1000).toISOString(),startedAt:new Date().toISOString(),responsePassed:true,toolPassed:true,requests:2,latencyMs:10,httpStatuses:[200,200]});await request('/api/v1/providers/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'groq',modelId:'groq:fixture'})});expect((await(await request('/api/v1/providers')).json()).providers[0].health).toBe('green');store.emit('runtime.inference.failed',{runId:'fixture',payload:{modelId:'groq:fixture',upstreamStatus:429,detail:'secret raw body'}});const row=(await(await request('/api/v1/providers')).json()).providers[0];expect(row.health).toBe('red');expect(row.reason).toContain('429');expect(JSON.stringify(store.company.providerFailures)).not.toContain('secret');store.emit('runtime.inference.finished',{runId:'fixture',payload:{modelId:'groq:fixture'}});await Promise.resolve();expect(store.company.providerFailures.groq).toBeNull();});

it('keeps private run inspection Owner-only and never reads a runtime-supplied arbitrary path',async()=>{
 const {store,request,root}=setup();
 const {RunInspection}=await import('../src/runtime/inspection.js');
 const employee=store.list('employees')[0];
 const assignment=store.put('assignments',{employeeId:employee.id,title:'Inspection boundary',status:'blocked'});
 const run=store.put('runs',{employeeId:employee.id,assignmentId:assignment.id,status:'failed',messagesPath:join(root,'owner-token')});
 new RunInspection(root,run.id).record('context',{text:'Permitted diagnostic'});
 const path=`/api/v1/runs/${run.id}/inspection`;
 expect((await request(path,{headers:{authorization:''}})).status).toBe(401);
 expect((await request(path,{headers:{authorization:'Bearer worker-token'}})).status).toBe(401);
 const content=await(await request(path)).json();expect(content.records[0].payload.text).toBe('Permitted diagnostic');
 expect(JSON.stringify(content)).not.toContain(readFileSync(join(root,'owner-token'),'utf8'));
 expect((await request(`${path}/preserve`,{method:'POST'})).status).toBe(200);
 expect((await(await request(path)).json()).selected).toBe(true);
});


it('retains an individual pause through recovery and refuses resumption before effect reconciliation',async()=>{
 const {store,request}=setup(),owner={kind:'owner'} as const;
 const employee=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 store.put('models',{id:employee.modelId,name:employee.modelId,artifactIdentity:'local-fixture',local:true,available:true,capabilities:['tools']});
 store.command(owner,{type:'control',action:'start'});
 const task=store.command(owner,{type:'assignment.create',employeeId:employee.id,title:'Preserve useful work',instructions:'Inspect retained work',acceptance:['Report findings'],kind:'assessment'});
 const run=store.claimNext({assignmentId:task.id,workspace:'/synthetic/preserved-work'})!;
 const command=(data:object,authorized=true)=>request('/api/v1/command',{method:'POST',headers:{'content-type':'application/json',...(authorized?{}:{authorization:''})},body:JSON.stringify({type:'assignment.update',assignmentId:task.id,...data})});
 expect((await command({paused:true,rationale:'Inspect interruption'},false)).status).toBe(401);
 expect((await command({paused:true,rationale:'Inspect interruption'})).status).toBe(200);
 expect(store.need('runs',run.id).tokenRevoked).toBe(true);
 expect((await command({paused:false,rationale:'Too early'})).status).toBe(409);
 store.recoverRuns(()=> 'absent');
 expect(store.claimNext({assignmentId:task.id})).toBeUndefined();
 const action=store.put('actions',{runId:run.id,employeeId:employee.id,productId:store.list('products')[0].id,kind:'communication',target:'synthetic',content:{},dedupeKey:'synthetic-intervention',status:'uncertain',cost:0,costEvidence:'synthetic',policyRevision:store.policy.revision});
 expect((await command({paused:false,rationale:'Uncertain effect remains'})).status).toBe(409);
 store.reconcileAction(action.id,{state:'present',evidence:'Synthetic provider observation',remoteRef:'synthetic-receipt'});
 expect((await command({guidance:'Report the remaining limitation only.',rationale:'Narrow the next response'})).status).toBe(200);
 expect((await command({paused:false,rationale:'Runtime absent and effect confirmed'})).status).toBe(200);
 const next=store.claimNext({assignmentId:task.id})!;
 expect(next.employeeId).toBe(employee.id);expect(next.workspace).toBe(run.workspace);
 expect(store.need('assignments',task.id).instructions).toContain('Report the remaining limitation only.');
 expect(store.need('actions',action.id).status).toBe('succeeded');
 expect(()=>store.dispatchAction({kind:'employee',employeeId:employee.id,runId:run.id,policyRevision:store.policy.revision},action.id)).toThrow();
});
