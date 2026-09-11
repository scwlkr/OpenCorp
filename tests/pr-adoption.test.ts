import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CompanyStore} from '../src/storage/store.js';
import {CorporateBroker} from '../src/tools/broker.js';
import {checked} from '../src/tools/process.js';
import {prepareProductDependencies} from '../src/tools/dependencies.js';
import {executeSandboxed} from '../src/runtime/index.js';
import {deliveryFor,projectDispatchAllowed,workspaceAdvancePending} from '../src/core/delivery.js';
import {ownerApp} from '../src/server/app.js';
import type {Actor,Artifact,Assignment,Employee,EmployeeRun,Product,Project} from '../src/core/types.js';
import type {LocalRuntime} from '../src/runtime/index.js';
import type {Scheduler} from '../src/scheduler/scheduler.js';

vi.mock('../src/tools/process.js',async original=>({...await original<typeof import('../src/tools/process.js')>(),checked:vi.fn()}));
vi.mock('../src/tools/dependencies.js',async original=>({...await original<typeof import('../src/tools/dependencies.js')>(),prepareProductDependencies:vi.fn()}));
vi.mock('../src/runtime/index.js',async original=>({...await original<typeof import('../src/runtime/index.js')>(),executeSandboxed:vi.fn()}));
const actual=await vi.importActual<typeof import('../src/tools/process.js')>('../src/tools/process.js');
const owner={kind:'owner'} as const,repo='fixture/product';
let root:string,provider:string,store:CompanyStore,broker:CorporateBroker,product:Product,project:Project,worker:Employee,ceo:Employee;
let base:string,head:string,pr:any,visibility:boolean,remoteChecks:any[],mutations:Array<{args:string[];input:any}>,gitCalls:string[][];
let intercept:((file:string,args:string[],options:any)=>Promise<string|undefined>)|undefined;
const git=(cwd:string,args:string[])=>execFileSync('/usr/bin/git',['-C',cwd,'-c','core.hooksPath=/dev/null','-c','user.name=External fixture author','-c','user.email=fixture@example.invalid',...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};

beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-adoption-'));provider=join(root,'provider');mkdirSync(provider);git(provider,['init','-b','main']);
 mkdirSync(join(provider,'.github/workflows'),{recursive:true});writeFileSync(join(provider,'.github/workflows/ci.yml'),'name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    env:\n      WALK_RELEASE_VERSION: v1.2.3\n    steps:\n      - uses: actions/checkout@v4\n      - run: make test\n');
 writeFileSync(join(provider,'source.txt'),'baseline source\n');git(provider,['add','.']);git(provider,['commit','-m','Fixture baseline']);base=git(provider,['rev-parse','HEAD']);
 writeFileSync(join(provider,'source.txt'),'externally authored dependency improvement\n');git(provider,['commit','-am','External contribution']);head=git(provider,['rev-parse','HEAD']);git(provider,['update-ref','refs/pull/12/head',head]);
 store=new CompanyStore(join(root,'state'));store.bootstrap();ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;store.put('models',{name:ceo.modelId,local:true,available:true,artifactIdentity:'disposable-model-no-inference',capabilities:['tools']});
 const position=store.command(owner,{type:'position.create',title:'Independent source custodian',level:'worker',responsibilities:'Evaluate a selected external candidate'});worker=store.command(owner,{type:'employee.hire',positionId:position.id,name:'Fixture custodian',homeManagerId:ceo.id,modelId:ceo.modelId});
 product=store.list('products')[0];const mirror=join(store.dataRoot,'repositories',`${product.id}.git`);mkdirSync(join(store.dataRoot,'repositories'),{recursive:true});git(root,['clone','--quiet','--bare',provider,mirror]);
 product=store.update('products',product.id,{binding:{repository:repo,url:`https://github.com/${repo}`,defaultBranch:'main',mirror,baseCommit:base,public:true}});
 project=store.command(owner,{type:'project.create',name:'Preserved authored work and external contribution',productId:product.id,outcome:'Evaluate independently',acceptance:['Selected external contribution is reviewed and delivered'],supervisorId:ceo.id,rationale:'Disposable integration fixture'});
 broker=new CorporateBroker(store,store.dataRoot);mutations=[];gitCalls=[];intercept=undefined;visibility=false;remoteChecks=[{status:'COMPLETED',conclusion:'SUCCESS'}];
 pr={number:12,html_url:`https://github.com/${repo}/pull/12`,user:{login:'external-contributor'},base:{repo:{full_name:repo},ref:'main',sha:base},head:{repo:{full_name:'contributor/fork'},ref:'dependency-update',sha:head},title:'External dependency improvement',body:'A focused externally authored change.',state:'open',merged:false,draft:false,mergeable:true};
 vi.mocked(checked).mockReset();vi.mocked(checked).mockImplementation(async(file,args,options={})=>{
  const custom=await intercept?.(file,args,options);if(custom!==undefined)return custom;
  if(file==='git'){
   gitCalls.push(args);if(args.includes('push'))throw new Error('Adoption must never push');
   const rewritten=args.map(arg=>arg===`https://github.com/${repo}.git`?provider:arg);
   if(rewritten.some(arg=>/^https?:/.test(arg)))throw new Error('Unexpected fixture network Git target');
   return actual.checked(file,rewritten,options);
  }
  if(file!=='gh')throw new Error(`Unexpected fixture process ${file}`);
  if(args.includes('POST')||args.includes('PUT')||args.includes('PATCH')){
   const input=JSON.parse(String(options.input??'{}'));mutations.push({args,input});
   if(args.includes('PUT')&&args.includes(`repos/${repo}/pulls/12/merge`)){expect(input.sha).toBe(head);pr.merged=true;pr.state='closed';pr.merge_commit_sha=head;return JSON.stringify({merged:true,sha:head});}
   if(args.includes('POST')&&args.includes(`repos/${repo}/issues/7/comments`))return JSON.stringify({id:700,html_url:`https://github.com/${repo}/issues/7#issuecomment-700`});
   throw new Error('Adoption attempted unapproved provider mutation');
  }
  if(args[0]==='pr'&&args[1]==='view')return JSON.stringify({number:pr.number,url:pr.html_url,headRefOid:pr.head.sha,baseRefName:pr.base.ref,state:pr.merged?'MERGED':'OPEN',title:pr.title,body:pr.body,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',statusCheckRollup:remoteChecks});
  if(args[1]==='user')return 'fixture';
  if(args[1]===`repos/${repo}/pulls/12`)return JSON.stringify(pr);
  if(args[1]===`repos/${repo}`)return JSON.stringify({private:visibility,default_branch:'main'});
  if(args[1]===`repos/${repo}/commits/main`)return JSON.stringify({sha:pr.merged?head:base});
  if(args[1]?.startsWith(`repos/${repo}/compare/`))return JSON.stringify({status:'identical'});
  if(args[1]===`repos/${repo}/issues/7`)return args.includes('--jq')?`https://github.com/${repo}/issues/7`:JSON.stringify({number:7,title:'Broader dependency issue',body:'- [ ] Fix selected dependency\n- [ ] Complete release',state:'open'});
  throw new Error(`Unexpected mocked provider request ${args.join(' ')}`);
 });
 vi.mocked(prepareProductDependencies).mockReset();vi.mocked(prepareProductDependencies).mockImplementation(async options=>({workspace:options.workspace,productName:options.productName,lockDigest:'fixture-lock',installed:true,receiptPath:join(root,'disposable-dependency-receipt.json'),checks:[],artifacts:0,downloaded:0,reused:0,incrementalCost:0,environment:{binPaths:[],readPaths:[],writePaths:[],variables:{}}}));
 vi.mocked(executeSandboxed).mockReset();vi.mocked(executeSandboxed).mockResolvedValue({code:0,stdout:'Disposable canonical execution boundary',stderr:''});
 project=await broker.workspaces.ensure(project);writeFileSync(join(project.workspace!,'source.txt'),'preserved employee work\n');writeFileSync(join(project.workspace!,'untracked.txt'),'preserved unrelated contents\n');chmodSync(join(project.workspace!,'untracked.txt'),0o640);store.command(owner,{type:'control',action:'start'});
});
afterEach(async()=>{await broker?.cancel();store?.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
function assign(employee=worker,kind='implementation',payload:any={pullRequest:{number:12,headSha:head}}):Assignment{return store.command(owner,{type:'assignment.create',projectId:project.id,employeeId:employee.id,supervisorId:ceo.id,title:'Evaluate exact external candidate',instructions:'Import, check and independently review exact external source',acceptance:['The selected contribution passes independent review'],kind,payload});}
function active(assignment:Assignment,workspace:string){const run=store.claimNext({assignmentId:assignment.id,workspace})!;expect(run).toBeDefined();store.bindSession(run.id,`session-${run.id}`,workspace);return {run:store.need('runs',run.id),actor:{kind:'employee',employeeId:run.employeeId,runId:run.id,policyRevision:run.policyRevision} as Actor};}
function finish(run:EmployeeRun){store.finishRun(run.id,{status:'succeeded'});}
async function snapshot(){const p=store.need('projects',project.id);return {workspace:p.workspace,baseCommit:p.baseCommit,head:await broker.workspaces.head(p),status:await broker.workspaces.git(p,['status','--porcelain']),source:readFileSync(join(p.workspace!,'source.txt'),'utf8'),untracked:readFileSync(join(p.workspace!,'untracked.txt'),'utf8'),mode:statSync(join(p.workspace!,'untracked.txt')).mode,pointer:readFileSync(join(p.workspace!,'.git'),'utf8')};}
async function imported(){const assignment=assign(),candidate=await broker.workspaces.preparePullRequest(assignment,{assertActive:()=>{expect(store.company.state).toBe('running');}}),bound=active(assignment,candidate.workspace!);const artifact=await broker.call(bound.actor,'import_pull_request',{summary:'Custody of externally authored contribution'}) as Artifact;return {assignment,candidate,artifact,...bound};}
async function reviewer(artifact:Artifact,employee=ceo){const assignment=assign(employee,'review',{artifactId:artifact.id});return {assignment,...active(assignment,broker.workspaces.forAssignment(assignment).workspace!)};}
async function inspect(actor:Actor,artifact:Artifact){let offset=0;for(let i=0;i<20;i++){const page=await broker.call(actor,'inspect_artifact',{artifactId:artifact.id,offset,limit:6000});if(page.inspectionComplete)return page;offset=page.nextUninspectedOffset;}throw new Error('Fixture inspection did not complete');}
async function approved(){const item=await imported();await broker.verify(item.actor,item.artifact.id);finish(item.run);const review=await reviewer(item.artifact);await inspect(review.actor,item.artifact);await broker.call(review.actor,'review_work',{artifactId:item.artifact.id,verdict:'approved',rationale:'Read actual external diff and candidate canonical receipts'});return {...item,artifact:store.need('artifacts',item.artifact.id),review};}
const publish=(actor:Actor,artifact:Artifact,extra:any={})=>broker.github.deliver(actor,{productId:product.id,artifactId:artifact.id,title:'Ignored adoption title',body:'Ignored adoption body',...extra});

describe('existing PR adoption with real isolated Git worktrees',()=>{
 it('preserves dirty ordinary work while importing, verifying, inspecting and reviewing the external candidate',async()=>{
  const before=await snapshot(),item=await imported();expect(item.candidate.workspace).not.toBe(project.workspace);expect(await broker.workspaces.head(item.candidate)).toBe(head);expect(await broker.workspaces.clean(item.candidate)).toBe(true);
  expect(item.artifact).toMatchObject({identity:head,baseCommit:base,employeeId:worker.id,runId:item.run.id,sourcePullRequest:{authorLogin:'external-contributor',repository:repo,headRepository:'contributor/fork',headSha:head,baseSha:base},reviewWorkspace:{workspace:item.candidate.workspace}});
  await broker.verify(item.actor,item.artifact.id);expect(prepareProductDependencies).toHaveBeenCalledWith(expect.objectContaining({workspace:item.candidate.workspace}));expect(executeSandboxed).toHaveBeenCalledWith(expect.objectContaining({workspace:item.candidate.workspace}));finish(item.run);
  const review=await reviewer(item.artifact),page=await inspect(review.actor,item.artifact);expect(page.diff).toContain('+externally authored dependency improvement');expect(page.diff).not.toContain('preserved employee work');await broker.call(review.actor,'review_work',{artifactId:item.artifact.id,verdict:'approved',rationale:'Independently inspected external changes and checks'});
  expect(store.hasApprovedArtifact(item.assignment.id,head)).toBe(true);expect(await snapshot()).toEqual(before);expect(mutations).toEqual([]);
  const app=ownerApp({store,broker,scheduler:{} as Scheduler,runtime:{} as LocalRuntime,getUrl:()=> 'http://127.0.0.1:4310'}),token=readFileSync(join(store.dataRoot,'owner-token'),'utf8');
  const response=await app.request(`http://127.0.0.1:4310/api/v1/artifacts/${item.artifact.id}/content`,{headers:{host:'127.0.0.1:4310',authorization:`Bearer ${token}`}});expect(response.status).toBe(200);expect(await response.text()).toContain('+externally authored dependency improvement');
 });
 it.each(['number','repository','url','baseRef','invalidSha','headMoved'] as const)('rejects provider %s mismatch before candidate creation',async field=>{
  const before=await snapshot(),assignment=assign();if(field==='number')pr.number=99;if(field==='repository')pr.base.repo.full_name='other/product';if(field==='url')pr.html_url='https://github.com/other/product/pull/12';if(field==='baseRef')pr.base.ref='other';if(field==='invalidSha')pr.base.sha='main';if(field==='headMoved')pr.head.sha=base;
  await expect(broker.workspaces.preparePullRequest(assignment,{assertActive:()=>{}})).rejects.toThrow();expect(store.need('assignments',assignment.id).pullRequestCandidate).toBeUndefined();expect(existsSync(broker.workspaces.pullRequestWorkspace(assignment))).toBe(false);expect(await snapshot()).toEqual(before);
 });
 it.each(['baseSha','headSha','headRepository','headRef','authorLogin'] as const)('refuses a changed pinned %s when reusing a prepared candidate',async field=>{
  const assignment=assign();await broker.workspaces.preparePullRequest(assignment,{assertActive:()=>{}});const prior=store.need('assignments',assignment.id).pullRequestCandidate;
  if(field==='baseSha')pr.base.sha=head;if(field==='headSha')pr.head.sha=base;if(field==='headRepository')pr.head.repo.full_name='other/fork';if(field==='headRef')pr.head.ref='other';if(field==='authorLogin')pr.user.login='other';
  await expect(broker.workspaces.preparePullRequest(store.need('assignments',assignment.id),{assertActive:()=>{}})).rejects.toThrow(/changed|moved/);expect(store.need('assignments',assignment.id).pullRequestCandidate).toEqual(prior);
 });
 it.each(['metadata','fetch'] as const)('cancels a pending %s request without creating or recording candidate work',async phase=>{
  const before=await snapshot(),assignment=assign(),controller=new AbortController(),entered=deferred();
  intercept=async(file,args,options)=>{if(phase==='metadata'&&file==='gh'||phase==='fetch'&&file==='git'&&args.includes('fetch')){entered.resolve();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('fixture cancelled')), {once:true}));}return undefined;};
  const pending=broker.workspaces.preparePullRequest(assignment,{assertActive:()=>controller.signal.throwIfAborted(),signal:controller.signal});const result=expect(pending).rejects.toThrow(/cancelled/);await entered.promise;controller.abort();await result;expect(store.need('assignments',assignment.id).pullRequestCandidate).toBeUndefined();expect(store.list('artifacts')).toEqual([]);expect(await snapshot()).toEqual(before);
 });
 it('preserves a dirty prepared candidate rather than resetting it on retry',async()=>{const assignment=assign(),candidate=await broker.workspaces.preparePullRequest(assignment,{assertActive:()=>{}});writeFileSync(join(candidate.workspace!,'source.txt'),'preserve candidate changes');await expect(broker.workspaces.preparePullRequest(store.need('assignments',assignment.id),{assertActive:()=>{}})).rejects.toThrow(/changes|reset/);expect(readFileSync(join(candidate.workspace!,'source.txt'),'utf8')).toBe('preserve candidate changes');expect(gitCalls.some(args=>args.includes('reset'))).toBe(false);});
 it('rejects a PR ref moved between metadata inspection and the real fetch',async()=>{
  const assignment=assign(),before=await snapshot();git(provider,['update-ref','refs/pull/12/head',base]);
  await expect(broker.workspaces.preparePullRequest(assignment,{assertActive:()=>{}})).rejects.toThrow(/Fetched PR ref/);expect(store.need('assignments',assignment.id).pullRequestCandidate).toBeUndefined();expect(await snapshot()).toEqual(before);
 });
 it('retains a partially prepared worktree after cancellation without recording an artifact or resetting files',async()=>{
  const assignment=assign(),controller=new AbortController(),before=await snapshot();
  intercept=async(file,args,options)=>{if(file==='git'&&args.includes('worktree')&&args.includes('add')){const result=await actual.checked(file,args,options);controller.abort();return result;}return undefined;};
  await expect(broker.workspaces.preparePullRequest(assignment,{assertActive:()=>controller.signal.throwIfAborted(),signal:controller.signal})).rejects.toThrow();
  const path=broker.workspaces.pullRequestWorkspace(assignment);expect(existsSync(path)).toBe(true);expect(git(path,['rev-parse','HEAD'])).toBe(head);expect(store.need('assignments',assignment.id).pullRequestCandidate).toBeUndefined();expect(store.list('artifacts')).toEqual([]);expect(await snapshot()).toEqual(before);
 });
 it('denies native artifact relabeling, self-review and incomplete or unverified approval',async()=>{
  const item=await imported();await expect(broker.call(item.actor,'commit_work',{summary:'Relabel external source'})).rejects.toThrow(/external|selected|Imported/i);await expect(broker.call(item.actor,'record_artifact',{path:'source.txt',summary:'Relabel file'})).rejects.toThrow(/external|selected|Imported/i);await broker.verify(item.actor,item.artifact.id);finish(item.run);
  await expect(reviewer(item.artifact,worker)).rejects.toThrow(/author cannot review/);
  // Future invalid claims stop before native dispatch; a pre-existing legacy run
  // still cannot bypass the independent verdict guard after actual inspection.
  const legacy=store.update('assignments',assign(ceo,'review',{artifactId:item.artifact.id}).id,{employeeId:worker.id}),runs=store.list('runs');expect(store.claimNext({assignmentId:legacy.id})).toBeUndefined();expect(store.list('runs')).toEqual(runs);expect(store.need('assignments',legacy.id)).toMatchObject({status:'blocked',reviewScopeIssue:{code:'independent_review_required'}});
  const selfRun=store.put('runs',{...item.run,id:undefined,assignmentId:legacy.id,employeeId:worker.id,status:'running',tokenRevoked:false,sessionId:randomUUID()});store.update('assignments',legacy.id,{status:'running'});const selfActor:Actor={kind:'employee',employeeId:worker.id,runId:selfRun.id,policyRevision:selfRun.policyRevision};await inspect(selfActor,item.artifact);await expect(broker.call(selfActor,'review_work',{artifactId:item.artifact.id,verdict:'approved',rationale:'Self approval'})).rejects.toThrow(/Author cannot/);finish(selfRun);store.update('artifacts',item.artifact.id,{checks:[],verification:{passed:false}});
  const review=await reviewer(item.artifact);await broker.call(review.actor,'inspect_artifact',{artifactId:item.artifact.id,limit:1});await expect(broker.call(review.actor,'review_work',{artifactId:item.artifact.id,verdict:'approved',rationale:'Partially read approval'})).rejects.toThrow(/inspection|every/i);await inspect(review.actor,item.artifact);await expect(broker.call(review.actor,'review_work',{artifactId:item.artifact.id,verdict:'approved',rationale:'Unchecked approval'})).rejects.toThrow(/checks|verif/i);expect(store.list('reviews')).toEqual([]);
 });
 it.each(['null source','missing workspace','wrong assignment','wrong mirror','symlink'] as const)('rejects %s provenance instead of falling back to the ordinary workspace',async field=>{
  const item=await imported(),artifact=structuredClone(item.artifact);if(field==='null source')artifact.sourcePullRequest=null as any;if(field==='missing workspace')delete artifact.reviewWorkspace;if(field==='wrong assignment')artifact.assignmentId=assign().id;if(field==='wrong mirror')store.update('products',product.id,{binding:{...product.binding,mirror:join(root,'another.git')}});if(field==='symlink'){const path=item.candidate.workspace!;rmSync(path,{recursive:true});symlinkSync(project.workspace!,path);}
  expect(()=>broker.workspaces.artifact(project,artifact)).toThrow();expect(mutations).toEqual([]);
 });
 it('does not prepare dependencies or launch native checks after pause during the first PR metadata wait',async()=>{
  const item=await imported(),entered=deferred(),release=deferred();intercept=async(file,args)=>{if(file==='gh'&&args[1]===`repos/${repo}/pulls/12`){entered.resolve();await release.promise;return JSON.stringify(pr);}return undefined;};
  const pending=broker.verify(item.actor,item.artifact.id),rejected=expect(pending).rejects.toThrow();await entered.promise;store.command(owner,{type:'control',action:'pause'});release.resolve();await rejected;expect(prepareProductDependencies).not.toHaveBeenCalled();expect(executeSandboxed).not.toHaveBeenCalled();
 });
 it('binds an existing reviewed PR without publication, then merges exact SHA without resetting or locking ordinary work',async()=>{
  const before=await snapshot(),item=await approved();await publish(item.review.actor,item.artifact);expect(mutations).toEqual([]);expect(store.list('actions')).toEqual([]);
  await broker.github.merge(item.review.actor,{productId:product.id,artifactId:item.artifact.id});expect(mutations).toHaveLength(1);expect(mutations[0]).toMatchObject({input:{sha:head,merge_method:'squash'}});expect(mutations[0].args).toContain('PUT');expect(gitCalls.some(args=>args.includes('push')||args.includes('reset'))).toBe(false);
  const updated=store.need('projects',project.id),receipt=deliveryFor(updated,item.artifact.id)!;expect(receipt).toMatchObject({source:'existing-pr',state:'merged',identity:head,mergeCommit:head});expect(receipt.publicationActionId).toBeUndefined();expect(receipt.workspaceAdvance).toBeUndefined();expect(workspaceAdvancePending(updated)).toBe(false);expect(projectDispatchAllowed(updated,assign(ceo,'management',{}))).toBe(true);expect(await snapshot()).toEqual(before);
  const action=store.list('actions')[0];expect(action).toMatchObject({kind:'merge',status:'succeeded',artifactId:item.artifact.id,cost:0,costPreflight:{artifactId:item.artifact.id,artifactIdentity:head,visibility:'public',defaultBranchHead:base}});
  await broker.github.merge(item.review.actor,{productId:product.id,artifactId:item.artifact.id});expect(mutations).toHaveLength(1);
 });
 it.each(['private','failed checks','head moved','closing syntax'] as const)('denies %s before an imported provider merge',async problem=>{
  const item=await approved();await publish(item.review.actor,item.artifact);if(problem==='private')visibility=true;if(problem==='failed checks')remoteChecks=[{status:'COMPLETED',conclusion:'FAILURE'}];if(problem==='head moved')pr.head.sha=base;if(problem==='closing syntax')pr.body='Fixes #7';await expect(broker.github.merge(item.review.actor,{productId:product.id,artifactId:item.artifact.id})).rejects.toThrow();expect(mutations).toEqual([]);
 });
 it('retains an honest partial issue gate and posts its exact evidence only after observed merge',async()=>{
  const item=await approved();await expect(publish(item.review.actor,item.artifact,{issueNumber:7})).rejects.toThrow(/remainingGate/);await publish(item.review.actor,item.artifact,{issueNumber:7,remainingGate:'Complete the independently required release'});expect(mutations).toEqual([]);
  await broker.github.merge(item.review.actor,{productId:product.id,artifactId:item.artifact.id});expect(mutations).toHaveLength(2);expect(mutations[1].input.body).toContain('Complete the independently required release');expect(mutations[1].input.body).toContain(head);expect(mutations[1].input.body).toContain('opencorp-action:');expect(deliveryFor(store.need('projects',project.id),item.artifact.id)?.issueEvidenceActionId).toBeDefined();
 });
 it('requires full exact issue acceptance before adopting a PR with a closing directive',async()=>{
  const item=await approved();pr.body='Closes #7.';await expect(publish(item.review.actor,item.artifact,{issueNumber:7,closeIssue:true})).rejects.toThrow(/issueAcceptance|review/i);expect(deliveryFor(store.need('projects',project.id),item.artifact.id)).toBeUndefined();expect(mutations).toEqual([]);
 });
 it('binds an existing closing directive only after full independently inspected exact issue acceptance',async()=>{
  const item=await imported();await broker.verify(item.actor,item.artifact.id);finish(item.run);const review=await reviewer(item.artifact);await inspect(review.actor,item.artifact);const issue=await broker.call(review.actor,'repo_issue',{productId:product.id,number:7,live:true});expect(issue.inspectionComplete).toBe(true);
  await broker.call(review.actor,'review_work',{artifactId:item.artifact.id,verdict:'approved',rationale:'Exact complete issue acceptance evaluated in disposable fixture',issueAcceptance:{issueNumber:7,issueIdentity:issue.issueIdentity,scopeRationale:'Fixture reviewer separately covers every original criterion',criteria:['Fix selected dependency','Complete release'].map(criterion=>({criterion,rationale:'Disposable independent coverage assertion',evidence:`Fixture source supports ${criterion}`}))}});
  pr.body='Closes #7.';await publish(review.actor,store.need('artifacts',item.artifact.id),{issueNumber:7,closeIssue:true});expect(mutations).toEqual([]);expect(deliveryFor(store.need('projects',project.id),item.artifact.id)).toMatchObject({source:'existing-pr',closeIssue:true,issueNumber:7,issueReviewId:store.list('reviews')[0].id});
 });
 it('rejects newly observed closing text at the last imported publication and merge preflight',async()=>{
  const item=await approved();let reads=0;intercept=async(file,args)=>{if(file==='gh'&&args[1]===`repos/${repo}/pulls/12`&&++reads===2)pr.body='Closes #7.';return undefined;};
  await expect(publish(item.review.actor,item.artifact)).rejects.toThrow(/closing/i);expect(deliveryFor(store.need('projects',project.id),item.artifact.id)).toBeUndefined();expect(mutations).toEqual([]);
  intercept=undefined;pr.body='Focused contribution';await publish(item.review.actor,item.artifact);reads=0;intercept=async(file,args)=>{if(file==='gh'&&args[1]===`repos/${repo}/pulls/12`&&++reads===2)pr.body='Closes #7.';return undefined;};
  await expect(broker.github.merge(item.review.actor,{productId:product.id,artifactId:item.artifact.id})).rejects.toThrow(/closing/i);expect(mutations).toEqual([]);
 });
 it('reconciles a lost merge response without a second provider write or ordinary workspace change',async()=>{
  const before=await snapshot(),item=await approved();await publish(item.review.actor,item.artifact);intercept=async(file,args,options)=>{if(file==='gh'&&args.includes('PUT')){mutations.push({args,input:JSON.parse(options.input)});pr.merged=true;pr.state='closed';pr.merge_commit_sha=head;throw new Error('Fixture response lost after actual provider observation');}return undefined;};
  await expect(broker.github.merge(item.review.actor,{productId:product.id,artifactId:item.artifact.id})).rejects.toThrow(/uncertain/);const action=store.list('actions').find(a=>a.kind==='merge')!;expect(action.status).toBe('uncertain');expect(mutations).toHaveLength(1);intercept=undefined;
  await broker.github.reconcile(action.id);expect(store.need('actions',action.id).status).toBe('succeeded');await broker.github.merge(item.review.actor,{productId:product.id,artifactId:item.artifact.id});expect(deliveryFor(store.need('projects',project.id),item.artifact.id)?.state).toBe('merged');expect(mutations).toHaveLength(1);expect(await snapshot()).toEqual(before);
 });
 it('does not accept a merged observation redirected to a different repository identity',async()=>{
  const item=await approved();await publish(item.review.actor,item.artifact);pr.merged=true;pr.state='closed';pr.merge_commit_sha=head;pr.base.repo.full_name='outside/renamed-product';pr.html_url='https://github.com/outside/renamed-product/pull/12';
  await expect(broker.github.merge(item.review.actor,{productId:product.id,artifactId:item.artifact.id})).rejects.toThrow();expect(deliveryFor(store.need('projects',project.id),item.artifact.id)?.state).toBe('awaiting_checks');expect(mutations).toEqual([]);
 });
 it('keeps an uncertain imported merge unresolved when provider repository identity differs',async()=>{
  const item=await approved();await publish(item.review.actor,item.artifact);intercept=async(file,args)=>{if(file==='gh'&&args.includes('PUT'))throw new Error('Fixture merge response lost');return undefined;};
  await expect(broker.github.merge(item.review.actor,{productId:product.id,artifactId:item.artifact.id})).rejects.toThrow(/uncertain/);const action=store.list('actions').find(a=>a.kind==='merge')!;intercept=undefined;pr.merged=true;pr.state='closed';pr.merge_commit_sha=head;pr.base.repo.full_name='outside/renamed-product';pr.html_url='https://github.com/outside/renamed-product/pull/12';
  await broker.github.reconcile(action.id).catch(()=>{});expect(store.need('actions',action.id).status).toBe('uncertain');expect(deliveryFor(store.need('projects',project.id),item.artifact.id)?.state).toBe('awaiting_checks');
 });
 it('allows supplemental independent acceptance after observed imported merge, preserving original evidence and workspace',async()=>{
  const before=await snapshot(),item=await approved();await publish(item.review.actor,item.artifact);await broker.github.merge(item.review.actor,{productId:product.id,artifactId:item.artifact.id});finish(item.review.run);const prior=store.list('reviews')[0],original=store.need('assignments',item.assignment.id),later=await reviewer(item.artifact);await inspect(later.actor,item.artifact);
  await broker.call(later.actor,'review_work',{artifactId:item.artifact.id,verdict:'approved',rationale:'Independent historical delivery criterion inspection',supplementalAcceptance:true,projectAcceptance:[{criterion:project.acceptance[0],source:'delivery',evidence:'Exact candidate reviewed and merge observed'}]});expect(store.list('reviews')).toHaveLength(2);expect(store.need('reviews',prior.id)).toEqual(prior);expect(store.need('assignments',item.assignment.id)).toEqual(original);expect(await snapshot()).toEqual(before);
 });
});
