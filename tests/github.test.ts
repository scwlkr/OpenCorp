import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TelegramTransport, type TelegramApi } from '../src/server/telegram.js';
import { CompanyStore } from '../src/storage/store.js';
import { GitHubDelivery, assertFreeWorkflow, assertNoClosingSyntax, qualifyWalkLangReleaseVersion } from '../src/tools/github.js';
import { CorporateBroker, brokerTools, corporateGuide } from '../src/tools/broker.js';
import { checked } from '../src/tools/process.js';
import type { WorkspaceManager } from '../src/tools/workspaces.js';
import type { Actor, Artifact, Project } from '../src/core/types.js';

vi.mock('../src/tools/process.js',async importOriginal=>{const actual=await importOriginal<typeof import('../src/tools/process.js')>();return {...actual,checked:vi.fn(actual.checked)};});
const checkedMock=vi.mocked(checked);
const actualProcess=await vi.importActual<typeof import('../src/tools/process.js')>('../src/tools/process.js');
const workflow='name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n';
const model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
const owner={kind:'owner'} as const;
const defaultHead='c'.repeat(40);
let root:string,store:CompanyStore,project:Project,artifact:Artifact,actor:Actor,delivery:GitHubDelivery,workspaces:WorkspaceManager;
let sends:string[];let workspaceHead:string|undefined;

beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),'opencorp-github-'));store=new CompanyStore(root);store.bootstrap();store.put('models',{name:model,artifactIdentity:'local-model-digest',local:true,available:true,capabilities:['tools']});store.command(owner,{type:'control',action:'start'});sends=[];workspaceHead=undefined;checkedMock.mockReset();checkedMock.mockImplementation(actualProcess.checked);
  const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!,product=store.list('products')[0];
  store.update('products',product.id,{binding:{repository:'test-owner/product',url:'https://github.com/test-owner/product',public:true,defaultBranch:'main',mirror:join(root,'repositories','product.git'),baseCommit:'base'}});
  project=store.command(owner,{type:'project.create',name:'Compiler fix',productId:product.id,outcome:'Handle observed edge case',acceptance:['Canonical tests pass'],supervisorId:ceo.id,rationale:'Live product issue'});
  project=store.update('projects',project.id,{workspace:join(root,'workspaces',project.id),gitDir:join(root,'repositories','product.git'),branch:`opencorp/${project.id}`,baseCommit:'base'});
  const position=store.command(owner,{type:'position.create',title:'Compiler worker',level:'worker',responsibilities:'Implement compiler changes'}),worker=store.command(owner,{type:'employee.hire',name:'Compiler worker',positionId:position.id,homeManagerId:ceo.id,modelId:model});
  const original=store.command(owner,{type:'assignment.create',projectId:project.id,employeeId:worker.id,supervisorId:ceo.id,title:'Fix edge case',instructions:'Fix real issue',acceptance:['Verifier passes'],kind:'implementation'});
  const work=store.command(owner,{type:'assignment.create',projectId:project.id,employeeId:ceo.id,supervisorId:ceo.id,title:'Deliver reviewed fix',instructions:'Use reviewed artifact',acceptance:['Delivered through GitHub'],kind:'management'});
  const run=store.put('runs',{employeeId:ceo.id,assignmentId:work.id,modelId:model,policyRevision:store.policy.revision,workspace:project.workspace,sessionId:'delivery-session',status:'running',attempt:1,leaseUntil:new Date(Date.now()+60000).toISOString(),heartbeatAt:new Date().toISOString(),tokenRevoked:false});
  actor={kind:'employee',employeeId:ceo.id,runId:run.id,policyRevision:store.policy.revision};
  artifact=store.put('artifacts',{assignmentId:original.id,projectId:project.id,employeeId:worker.id,runId:'author-run',uri:'https://github.com/test-owner/product/commit/reviewed-head',identity:'reviewed-head',kind:'commit',summary:'Handle compiler edge case',checks:[{source:'canonical-verifier',identity:'reviewed-head',status:'passed'}],verification:{identity:'reviewed-head',passed:true,receiptId:'trusted-receipt'}});
  store.put('reviews',{artifactId:artifact.id,artifactIdentity:artifact.identity,employeeId:ceo.id,runId:'independent-review-run',verdict:'approved',rationale:'Inspected cumulative diff and canonical checks',checks:artifact.checks});
  workspaces={head:vi.fn(async()=>workspaceHead??artifact.identity),clean:vi.fn(async()=>true),git:vi.fn(async(_project,args)=>{if(args.includes('reset')){workspaceHead=args.at(-1);return '';}if(args.includes('diff')&&args.at(-1)==='.github/workflows')return '';return args.includes('rev-parse')?'fixture-tree':'src/parser.ts';})} as unknown as WorkspaceManager;
  delivery=new GitHubDelivery(store,workspaces);
});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});

function providerReads(overrides?: (file:string,args:string[],options:any)=>Promise<string|undefined>) {
  checkedMock.mockImplementation(async(file,args,options={})=>{
    if (args.includes('POST')||args.includes('PUT')||args.includes('push')) sends.push(`${file} ${args.join(' ')}`);
    const override=await overrides?.(file,args,options);if(override!==undefined){if(file==='gh'&&args[0]==='pr'&&args[1]==='view')return JSON.stringify({title:'Actual fixture outcome',body:'Observed reviewed change',...JSON.parse(override)});return override;}
    if(file==='gh'&&args.includes('user'))return 'test-owner';
    if(file==='gh'&&args[0]==='api'&&args[1]==='repos/test-owner/product')return JSON.stringify({private:false,default_branch:'main'});
    if(file==='gh'&&args[0]==='api'&&args[1]==='repos/test-owner/product/commits/main')return JSON.stringify({sha:defaultHead});
    if(file==='git'&&args.includes('fetch'))return '';
    if(file==='git'&&args.includes('ls-tree'))return '.github/workflows/ci.yml';
    if(file==='git'&&args.includes('show'))return workflow;
    if(file==='git'&&args.includes('push'))return '';
    if(file==='gh'&&args[0]==='pr'&&args[1]==='list')return '[]';
    if(file==='gh'&&args[1]?.match(/^repos\/test-owner\/product\/issues\/\d+$/))return JSON.stringify({number:Number(args[1].split('/').at(-1)),title:'Real tracked outcome',body:'- [ ] Parser handles edge case\n- [ ] Release verified',state:'open'});
    if(file==='gh'&&args.includes('POST'))return JSON.stringify({number:1,html_url:'https://github.com/test-owner/product/pull/1',head:{sha:artifact.identity}});
    throw new Error(`Unexpected mocked provider request: ${file} ${args.join(' ')}`);
  });
}

describe('external publication boundaries',()=>{
  it.each(['issue_comment','pr_comment'] as const)('advertises the explicit %s target and rejects an omitted number before intent or provider access',async kind=>{
    const schema=brokerTools.find(tool=>tool.name==='communicate')!.inputSchema;
    expect(schema.properties.number).toMatchObject({type:'integer',minimum:1});expect(schema.properties.number.description).toContain(kind);expect(schema.properties.number.description).toContain('Omit for issue_create');expect(schema.required).toEqual(['kind','content','dedupeKey']);
    const example=JSON.parse(corporateGuide.match(/Example: communicate (\{[^\n]+?\})\./)![1]);expect(example).toMatchObject({kind:'pr_comment',number:12});expect(Object.keys(example)).toEqual(['kind','number','content','dedupeKey']);
    const before=store.list('actions');await expect(delivery.communicate(actor,{productId:project.productId!,kind,content:'Actual source findings for the selected target.',dedupeKey:'fixture-comment'})).rejects.toMatchObject({code:'invalid_target',message:expect.stringMatching(new RegExp(`${kind}.*requires number.*directly beside kind`))});expect(store.list('actions')).toEqual(before);expect(checkedMock).not.toHaveBeenCalled();
  });
  it('rejects a product made private after its cached public assessment before any dispatch',async()=>{
    providerReads(async(file,args)=>file==='gh'&&args[1]==='repos/test-owner/product'?JSON.stringify({private:true,default_branch:'main'}):undefined);
    await expect(delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Reviewed outcome',body:'Actual work'})).rejects.toThrow(/Live repository visibility/);expect(sends).toEqual([]);
  });
  it('checks current default workflows and rechecks visibility between the push and PR effects',async()=>{
    let privateNow=false;const heads:string[]=[];
    providerReads(async(file,args)=>{if(file==='git'&&args.includes('show')){heads.push(args.at(-1)!);return undefined;}if(file==='git'&&args.includes('push')){privateNow=true;return '';}if(file==='gh'&&args[1]==='repos/test-owner/product')return JSON.stringify({private:privateNow,default_branch:'main'});return undefined;});
    await expect(delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Reviewed outcome',body:'Actual work'})).rejects.toThrow(/Live repository visibility/);
    expect(heads).toContain(`${defaultHead}:.github/workflows/ci.yml`);expect(sends.filter(s=>s.includes('push'))).toHaveLength(1);expect(sends.some(s=>s.includes('POST'))).toBe(false);expect(store.list('actions').find(a=>a.kind==='branch_push')?.costPreflight).toMatchObject({visibility:'public',defaultBranchHead:defaultHead});
  });
  it('rejects newly metered default-branch workflows even when the reviewed baseline was free',async()=>{
    providerReads(async(file,args)=>file==='git'&&args.includes('show')&&args.at(-1)?.startsWith(`${defaultHead}:`)?workflow.replace('ubuntu-latest','macos-15-large'):undefined);
    await expect(delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Reviewed outcome',body:'Actual work'})).rejects.toThrow(/Unqualified runner/);expect(sends).toEqual([]);
  });
  it('uses live public visibility and retains per-effect zero-cost proof for normal known-free CI',async()=>{
    store.update('products',project.productId!,{binding:{...store.need('products',project.productId!).binding,public:false}});providerReads();
    await delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Reviewed outcome',body:'Actual work'});
    expect(sends.filter(s=>s.includes('push'))).toHaveLength(1);expect(sends.filter(s=>s.includes('POST'))).toHaveLength(1);for(const action of store.list('actions'))expect(action.costPreflight).toMatchObject({visibility:'public',defaultBranchHead:defaultHead});
  });
  it('rechecks current zero-cost conditions before merging a previously published PR',async()=>{
    store.update('projects',project.id,{delivery:{state:'awaiting_checks',prNumber:12,artifactId:artifact.id}});
    providerReads(async(file,args)=>{if(file==='gh'&&args[0]==='pr')return JSON.stringify({number:12,headRefOid:artifact.identity,baseRefName:'main',state:'OPEN',mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}]});if(file==='gh'&&args[1]==='repos/test-owner/product')return JSON.stringify({private:true,default_branch:'main'});return undefined;});
    await expect(delivery.merge(actor,{productId:project.productId!,artifactId:artifact.id})).rejects.toThrow(/Live repository visibility/);expect(sends).toEqual([]);
  });
  it('allows an already-dispatched push to reconcile but does not create a PR after pause',async()=>{
    let began!:()=>void,complete!:()=>void;
    const pushBegan=new Promise<void>(resolve=>{began=resolve;}),pushComplete=new Promise<void>(resolve=>{complete=resolve;});
    providerReads(async(file,args)=>{if(file==='git'&&args.includes('push')){began();await pushComplete;return '';}return undefined;});
    const pending=delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Fix parser edge case',body:'Actual reviewed compiler correction.'});
    const observed=pending.then(()=>({passed:true}),error=>({passed:false,error}));
    await pushBegan;store.command(owner,{type:'control',action:'pause'});complete();
    const result=await observed;expect(result.passed).toBe(false);expect(sends.filter(s=>s.includes('push'))).toHaveLength(1);expect(sends.some(s=>s.includes('POST')&&s.includes('/pulls'))).toBe(false);
    expect(store.list('actions').some(a=>a.status==='succeeded')).toBe(true);
  });
  it('reconciles an interrupted PR by marker and exact head, then returns it without another write',async()=>{
    providerReads(async(file,args)=>{if(file==='gh'&&args.includes('POST'))throw new Error('Transport disconnected after provider created the PR');return undefined;});
    await expect(delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Fix parser edge case',body:'Actual reviewed compiler correction.'})).rejects.toThrow(/uncertain/);
    const intent=store.list('actions').find(a=>a.kind==='pull_request')!;expect(intent.status).toBe('uncertain');sends=[];
    const remote={id:44,number:12,url:'https://github.com/test-owner/product/pull/12',html_url:'https://github.com/test-owner/product/pull/12',headRefOid:artifact.identity,head:{sha:artifact.identity,ref:intent.target.slice('test-owner/product:'.length)},body:`Actual reviewed compiler correction.\n<!-- opencorp-action:${intent.id} -->`,state:'OPEN'};
    providerReads(async(file,args)=>{if(file==='gh'&&(args[0]==='pr'||args.some(a=>a.includes('/pulls')))&&!args.includes('POST'))return JSON.stringify([remote]);return undefined;});
    await delivery.reconcile(intent.id);expect(store.need('actions',intent.id).status).toBe('succeeded');expect(store.need('actions',intent.id).remoteRef).toBe(remote.html_url);
    const result=await delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Fix parser edge case',body:'Actual reviewed compiler correction.'});
    expect(result.prNumber).toBe(12);expect(sends).toEqual([]);
  });
  it('keeps a matching marker with the wrong commit uncertain instead of claiming delivery',async()=>{
    const intent=store.put('actions',{employeeId:actor.kind==='employee'?actor.employeeId:'',runId:actor.kind==='employee'?actor.runId:'',productId:project.productId!,kind:'pull_request',target:`test-owner/product:${project.branch}`,content:{head:artifact.identity,branch:project.branch},dedupeKey:'uncertain-wrong-head',status:'uncertain',policyRevision:store.policy.revision,cost:0,costEvidence:'Existing public GitHub'});
    const remote={number:12,url:'https://github.com/test-owner/product/pull/12',html_url:'https://github.com/test-owner/product/pull/12',headRefOid:'different-commit',head:{sha:'different-commit',ref:project.branch},body:`<!-- opencorp-action:${intent.id} -->`};
    providerReads(async(file,args)=>file==='gh'&&(args[0]==='pr'||args.some(a=>a.includes('/pulls')))?JSON.stringify([remote]):undefined);
    await delivery.reconcile(intent.id);expect(store.need('actions',intent.id).status).toBe('uncertain');expect(sends).toEqual([]);
  });
  it.each([false,true])('resumes a never-dispatched PR with reserved approval %s while preserving the observed push and origin',async reserved=>{
    providerReads(async(file,args)=>{if(file==='git'&&args.includes('push')){store.command(owner,{type:'control',action:'pause'});return '';}return undefined;});
    await expect(delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Fix parser edge case',body:'Actual reviewed compiler correction.'})).rejects.toThrow();
    const former=actor.kind==='employee'?store.need('runs',actor.runId):undefined;if(!former)throw new Error('Fixture run missing');
    store.finishRun(former.id,{status:'interrupted'});store.command(owner,{type:'control',action:'resume'});
    if(reserved){
     const api:TelegramApi=async method=>({ok:true,result:method==='sendMessage'?{message_id:42}:[]});const transport=new TelegramTransport(store,{token:'123456:SYNTHETIC_TEST_TOKEN',ownerUserId:123,chatId:123},api);
     const action=store.list('actions').find(a=>a.kind==='pull_request')!,proposal=store.command(owner,{type:'owner.propose',title:'Resume reviewed publication',content:'Only this retained PR action.',proposalScope:'Create this exact reviewed PR.',actionId:action.id,expiresAt:new Date(Date.now()+3600000).toISOString(),channel:'telegram'});
     await transport.tick();await transport.tick();
     const incoming:TelegramApi=async()=>({ok:true,result:[{update_id:1,message:{message_id:9,from:{id:123},chat:{id:123,type:'private'},text:`APPROVE ${proposal.id}`,reply_to_message:{message_id:42}}}]});await new TelegramTransport(store,{token:'123456:SYNTHETIC_TEST_TOKEN',ownerUserId:123,chatId:123},incoming).tick();expect(store.need('attention',proposal.id).disposition?.decision).toBe('approved');
    }

    const next=store.put('runs',{...former,id:undefined,status:'running',tokenRevoked:false,policyRevision:store.policy.revision,sessionId:'resumed-session'});actor={kind:'employee',employeeId:next.employeeId,runId:next.id,policyRevision:next.policyRevision};sends=[];providerReads();
    const result=await delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Fix parser edge case',body:'Actual reviewed compiler correction.'});
    expect(result.prNumber).toBe(1);expect(sends.filter(s=>s.includes('push'))).toHaveLength(0);expect(sends.filter(s=>s.includes('POST'))).toHaveLength(1);
    const intent=store.list('actions').find(a=>a.kind==='pull_request')!;if(reserved){expect(intent.runId).toBe(former.id);expect(intent.dispatchRunId).toBe(next.id);}else{expect(intent.priorRunIds).toContain(former.id);expect(intent.runId).toBe(next.id);}
  });
  it('reconciles an interrupted issue creation by its durable marker without creating a duplicate issue',async()=>{
    const input={productId:project.productId!,kind:'issue_create' as const,title:'Observed compiler failure',content:'Actual reproducible user issue.',dedupeKey:'real-observed-issue'};
    providerReads(async(file,args)=>{if(file==='gh'&&args.includes('POST'))throw new Error('Transport disconnected after issue creation');return undefined;});
    await expect(delivery.communicate(actor,input)).rejects.toThrow(/uncertain/);
    const intent=store.list('actions').find(a=>a.kind==='communication')!;
    sends=[];providerReads(async(file,args)=>file==='gh'&&args.some(a=>a.includes('/issues?'))?JSON.stringify([{id:78,number:15,html_url:'https://github.com/test-owner/product/issues/15',body:`Actual reproducible user issue.\n<!-- opencorp-action:${intent.id} -->`}]):undefined);
    await delivery.reconcile(intent.id);const result=await delivery.communicate(actor,input);
    expect(result.status).toBe('succeeded');expect(result.remoteRef).toBe('https://github.com/test-owner/product/issues/15');expect(sends).toEqual([]);
  });
  it('refuses a remote PR head change before the merge request is dispatched',async()=>{
    store.update('projects',project.id,{delivery:{state:'awaiting_checks',prNumber:12,artifactId:artifact.id}});
    providerReads(async(file,args)=>file==='gh'&&args[0]==='pr'&&args[1]==='view'?JSON.stringify({number:12,headRefOid:'unreviewed-head',baseRefName:'main',state:'OPEN',mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}]}):undefined);
    await expect(delivery.merge(actor,{productId:project.productId!,artifactId:artifact.id})).rejects.toThrow(/reviewed commit/);expect(sends).toEqual([]);
  });
  it('restores the full merge receipt after the provider merged but its response was lost',async()=>{
    store.update('projects',project.id,{delivery:{state:'awaiting_checks',prNumber:12,artifactId:artifact.id,identity:artifact.identity}});
    let merged=false;
    providerReads(async(file,args)=>{
      if(file!=='gh')return undefined;
      if(args[0]==='pr'&&args[1]==='view')return JSON.stringify({number:12,url:'https://github.com/test-owner/product/pull/12',headRefOid:artifact.identity,baseRefName:'main',state:merged?'MERGED':'OPEN',mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}]});
      if(args.includes('PUT')){merged=true;throw new Error('Connection lost after provider merged');}
      if(args[1]==='repos/test-owner/product/pulls/12')return JSON.stringify({number:12,merged,head:{sha:artifact.identity},base:{ref:'main'},merge_commit_sha:'actual-merge',html_url:'https://github.com/test-owner/product/pull/12'});
      if(args[1]==='repos/test-owner/product/commits/main')return JSON.stringify({sha:defaultHead});
      if(args[1]===`repos/test-owner/product/compare/actual-merge...${defaultHead}`)return JSON.stringify({status:'ahead'});
      return undefined;
    });
    const input={productId:project.productId!,artifactId:artifact.id};
    await expect(delivery.merge(actor,input)).rejects.toThrow(/uncertain/);
    const action=store.list('actions').find(a=>a.kind==='merge')!;expect(action.status).toBe('uncertain');expect(sends).toHaveLength(1);
    sends=[];await delivery.reconcile(action.id);expect(store.need('actions',action.id).status).toBe('succeeded');
    const result=await delivery.merge(actor,input);expect(result).toMatchObject({state:'merged',mergeCommit:'actual-merge',defaultBranchHead:defaultHead});
    expect(store.need('projects',project.id).delivery).toMatchObject({state:'merged',artifactId:artifact.id,identity:artifact.identity,mergeCommit:'actual-merge',defaultBranchHead:defaultHead,prUrl:'https://github.com/test-owner/product/pull/12',deliveredAt:expect.any(String)});expect(sends).toEqual([]);
  });
  it('retries merged delivery through the public tool to reconcile lost issue evidence without duplicate sends',async()=>{
    store.update('projects',project.id,{delivery:{state:'awaiting_checks',prNumber:12,artifactId:artifact.id,identity:artifact.identity,issueNumber:7}});
    let commentBody='';
    providerReads(async(file,args,options)=>{
      if(file!=='gh')return undefined;
      if(args[0]==='pr')return JSON.stringify({number:12,state:'MERGED',headRefOid:artifact.identity,baseRefName:'main'});
      if(args[1]==='repos/test-owner/product/pulls/12')return JSON.stringify({number:12,merged:true,head:{sha:artifact.identity},base:{ref:'main'},merge_commit_sha:'merge',html_url:'https://github.com/test-owner/product/pull/12'});
      if(args[1]==='repos/test-owner/product/commits/main')return JSON.stringify({sha:'merge'});
      if(args[1]?.includes('/compare/'))return JSON.stringify({status:'identical'});
      if(args.includes('POST')){commentBody=JSON.parse(options.input).body;throw new Error('Transport lost after comment publication');}
      if(args[1]==='repos/test-owner/product/issues/7')return 'https://github.com/test-owner/product/issues/7';
      if(args[1]?.includes('/issues/7/comments?'))return JSON.stringify([{id:77,body:commentBody,html_url:'https://github.com/test-owner/product/issues/7#issuecomment-77'}]);
      return undefined;
    });
    const broker=new CorporateBroker(store,root);Object.defineProperty(broker,'github',{value:delivery});
    await expect(broker.call(actor,'deliver_product',{artifactId:artifact.id})).rejects.toThrow(/uncertain/);
    expect(store.need('projects',project.id).delivery.state).toBe('merged');
    const action=store.list('actions').find(a=>a.kind==='communication')!;expect(action.status).toBe('uncertain');expect(sends).toHaveLength(1);
    await broker.github.reconcile(action.id);sends=[];
    const result=await broker.call(actor,'deliver_product',{artifactId:artifact.id});expect(result.mergeCommit).toBe('merge');expect(store.need('actions',action.id).status).toBe('succeeded');expect(sends).toEqual([]);
  });
  it.each(['diverged','behind'])('does not claim an already-merged PR whose default branch ancestry is %s',async status=>{
    store.update('projects',project.id,{delivery:{state:'awaiting_checks',prNumber:12,artifactId:artifact.id}});
    providerReads(async(file,args)=>{
      if(file!=='gh')return undefined;
      if(args[0]==='pr')return JSON.stringify({number:12,state:'MERGED',headRefOid:artifact.identity,baseRefName:'main'});
      if(args[1]?.endsWith('/pulls/12'))return JSON.stringify({merged:true,head:{sha:artifact.identity},base:{ref:'main'},merge_commit_sha:'merge',html_url:'https://github.com/test-owner/product/pull/12'});
      if(args[1]?.endsWith('/commits/main'))return JSON.stringify({sha:'rewritten-default'});
      if(args[1]?.includes('/compare/'))return JSON.stringify({status});
      return undefined;
    });
    await expect(delivery.merge(actor,{productId:project.productId!,artifactId:artifact.id})).rejects.toThrow(/ancestry/);expect(store.need('projects',project.id).delivery.state).toBe('awaiting_checks');expect(sends).toEqual([]);
  });
  it('rejects larger runners, dynamic runners and unqualified reusable workflows before charging',()=>{
    expect(()=>assertFreeWorkflow(workflow)).not.toThrow();
    for(const runner of ['ubuntu-latest-16-cores','macos-15-large','${{ matrix.runner }}'])expect(()=>assertFreeWorkflow(workflow.replace('ubuntu-latest',runner))).toThrow(/Unqualified runner/);
    expect(()=>assertFreeWorkflow('jobs:\n  publish:\n    uses: external/provider/.github/workflows/deploy.yml@main\n')).toThrow(/Reusable workflow/);
  });
});

describe('reviewed branch identity',()=>{
  it('fails before cost qualification when an oversized workflow would hide credentialed content in the discarded prefix',async()=>{
    const workspace=project.workspace!,gitDir=project.gitDir!;mkdirSync(join(workspace,'.github/workflows'),{recursive:true});mkdirSync(join(root,'repositories'),{recursive:true});execFileSync('/usr/bin/git',['init','--bare',gitDir],{stdio:'pipe'});
    const text='env:\n  PAID_SERVICE_KEY: "${{ secrets.PAID_SERVICE_KEY }}"\n'+'#'.repeat(140000)+'\n'+workflow;expect(()=>assertFreeWorkflow(text)).toThrow(/Credentialed/);expect(()=>assertFreeWorkflow(text.slice(-120000).trim())).not.toThrow();
    writeFileSync(join(workspace,'.github/workflows/ci.yml'),text);const git=(args:string[])=>execFileSync('/usr/bin/git',['--git-dir',gitDir,'--work-tree',workspace,'-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8'}).trim();git(['add','--all']);git(['commit','-m','Large workflow regression']);
    await expect(delivery.checkFreeWorkflow(gitDir,git(['rev-parse','HEAD']))).rejects.toThrow(/stdout truncated/);expect(store.list('actions')).toHaveLength(0);expect(sends).toEqual([]);
  });
  it('exposes both commits in the delivered branch, including changes absent from the final commit',async()=>{
    const workspace=project.workspace!,gitDir=project.gitDir!;mkdirSync(workspace,{recursive:true});mkdirSync(join(root,'repositories'),{recursive:true});
    execFileSync('/usr/bin/git',['init','--bare','--initial-branch=main',gitDir],{stdio:'pipe'});writeFileSync(join(workspace,'.git'),`gitdir: ${gitDir}\n`);
    const git=(args:string[])=>execFileSync('/usr/bin/git',['--git-dir',gitDir,'--work-tree',workspace,'-c','user.name=Regression fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{cwd:workspace,env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8'}).trim();
    writeFileSync(join(workspace,'first.txt'),'original\n');writeFileSync(join(workspace,'last.txt'),'original\n');git(['add','--all']);git(['commit','-m','Base']);const base=git(['rev-parse','HEAD']);
    writeFileSync(join(workspace,'first.txt'),'UNREVIEWED_EARLY_CHANGE\n');git(['add','--all']);git(['commit','-m','First change']);
    writeFileSync(join(workspace,'last.txt'),'FINAL_CHANGE\n');git(['add','--all']);git(['commit','-m','Final change']);const head=git(['rev-parse','HEAD']);
    store.update('projects',project.id,{baseCommit:base});store.update('artifacts',artifact.id,{identity:head});
    const broker=new CorporateBroker(store,root);Object.defineProperty(broker,'github',{value:delivery});const inspected=await broker.call(actor,'inspect_artifact',{artifactId:artifact.id});
    expect(inspected.diff).toContain('UNREVIEWED_EARLY_CHANGE');expect(inspected.diff).toContain('FINAL_CHANGE');
  });
});


describe('truthful issue and sequential artifact delivery',()=>{
 it.each(['Closes #7','CLOSES: #7','fixes other/product#9','resolves https://github.com/other/product/issues/9','**Fixes:** [#7](https://github.com/test-owner/product/issues/7)'])('blocks caller closing syntax %s before an external intent',async text=>{
  providerReads();expect(()=>assertNoClosingSyntax(text)).toThrow(/closing keywords/);
  await expect(delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Actual milestone',body:text})).rejects.toMatchObject({code:'closing_syntax_denied'});expect(sends).toEqual([]);expect(store.list('actions')).toEqual([]);
 });
 it('requires an explicit remaining gate and publishes a nonclosing partial issue reference',async()=>{
  let body='';providerReads(async(file,args,options)=>{if(file==='gh'&&args.includes('POST'))body=JSON.parse(options.input).body;return undefined;});
  await expect(delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Partial parser improvement',body:'Correct one parser case',issueNumber:7})).rejects.toMatchObject({code:'remaining_gate_required'});expect(sends).toEqual([]);
  await delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Partial parser improvement',body:'Correct one parser case',issueNumber:7,remainingGate:'The issue still requires an actual release verification.'});
  expect(body).toContain('Related issue #7');expect(body).toContain('still requires an actual release');expect(body).not.toContain('Closes');expect(store.need('projects',project.id).delivery).toMatchObject({closeIssue:false,remainingGate:'The issue still requires an actual release verification.'});
 });
 it('gates explicit closure on the exact independent issue snapshot and rechecks changes before publication',async()=>{
  providerReads();const input={productId:project.productId!,artifactId:artifact.id,title:'Complete tracked outcome',body:'Actual complete outcome',issueNumber:7,closeIssue:true};
  await expect(delivery.deliver(actor,input)).rejects.toMatchObject({code:'issue_review_required'});expect(sends).toEqual([]);
  const issue=await delivery.readIssue(project.productId!,7),review=store.list('reviews')[0]!;
  store.update('reviews',review.id,{issueAcceptance:{...issue,artifactId:artifact.id,artifactIdentity:artifact.identity,reviewerId:review.employeeId,runId:review.runId}});
  providerReads(async(file,args)=>file==='gh'&&args[1]==='repos/test-owner/product/issues/7'?JSON.stringify({number:7,title:issue.title,body:issue.body+'\nNew required behavior',state:'open'}):undefined);
  await expect(delivery.deliver(actor,input)).rejects.toMatchObject({code:'issue_changed'});expect(sends).toEqual([]);
  let body='';providerReads(async(file,args,options)=>{if(file==='gh'&&args.includes('POST'))body=JSON.parse(options.input).body;return undefined;});
  await delivery.deliver(actor,input);expect(body).toContain('Closes #7.');expect(store.need('projects',project.id).delivery.issueReviewId).toBe(review.id);
 });
 it('blocks edited remote closing text before merge and controls the squash message',async()=>{
  store.update('projects',project.id,{delivery:{state:'awaiting_checks',prNumber:12,artifactId:artifact.id,identity:artifact.identity}});
  providerReads(async(file,args)=>file==='gh'&&args[0]==='pr'?JSON.stringify({number:12,headRefOid:artifact.identity,baseRefName:'main',state:'OPEN',title:'Actual outcome',body:'Fixes other/product#9',mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}]}):undefined);
  await expect(delivery.merge(actor,{productId:project.productId!,artifactId:artifact.id})).rejects.toMatchObject({code:'closing_syntax_denied'});expect(sends).toEqual([]);
 });
 it('publishes a second artifact on a different branch and keeps the prior receipt on historical retry',async()=>{
  const old={state:'merged',artifactId:'older-artifact',identity:'older-head',prNumber:3,prUrl:'https://github.com/test-owner/product/pull/3',mergeCommit:'older-merge',defaultBranchHead:'older-merge',deliveredAt:'2026-09-10T00:00:00.000Z'};
  store.update('projects',project.id,{delivery:old});providerReads();const broker=new CorporateBroker(store,root);Object.defineProperty(broker,'github',{value:delivery});
  const result=await broker.call(actor,'deliver_product',{artifactId:artifact.id,title:'Second milestone',body:'A separate reviewed improvement'});
  expect(result.prNumber).toBe(1);const state=store.need('projects',project.id);expect(state.deliveryHistory).toHaveLength(2);expect(state.deliveryHistory[0]).toEqual(old);expect(state.delivery.artifactId).toBe(artifact.id);expect(state.delivery.branch).toBe(`${project.branch}-delivery-${artifact.id}`);expect(sends.some(s=>s.includes(`refs/heads/${state.delivery.branch}`))).toBe(true);
  const oldArtifact=store.put('artifacts',{...artifact,id:'older-artifact',identity:'older-head',checks:[{source:'canonical-verifier',identity:'older-head',status:'passed'}],verification:{identity:'older-head',passed:true,receiptId:'old-proof'}});store.put('reviews',{...store.list('reviews')[0],id:undefined,artifactId:oldArtifact.id,artifactIdentity:oldArtifact.identity});
  providerReads(async(file,args)=>{if(file!=='gh')return undefined;if(args[0]==='pr')return JSON.stringify({number:3,headRefOid:'older-head',baseRefName:'main',state:'MERGED'});if(args[1]?.endsWith('/pulls/3'))return JSON.stringify({merged:true,head:{sha:'older-head'},base:{ref:'main'},merge_commit_sha:'older-merge',html_url:old.prUrl});if(args[1]?.includes('/compare/'))return JSON.stringify({status:'ahead'});return undefined;});
  await broker.call(actor,'deliver_product',{artifactId:oldArtifact.id});expect(store.need('projects',project.id).delivery.artifactId).toBe(artifact.id);expect(store.need('projects',project.id).deliveryHistory.find((item:any)=>item.artifactId===oldArtifact.id).mergeCommit).toBe('older-merge');
 });
 it('does not overwrite changed product workspace when advancing a confirmed merge',async()=>{
  store.update('projects',project.id,{delivery:{state:'awaiting_checks',prNumber:12,artifactId:artifact.id,identity:artifact.identity}});vi.mocked(workspaces.clean).mockResolvedValue(false);
  providerReads(async(file,args)=>{if(file!=='gh')return undefined;if(args[0]==='pr')return JSON.stringify({number:12,headRefOid:artifact.identity,baseRefName:'main',state:'MERGED'});if(args[1]?.endsWith('/pulls/12'))return JSON.stringify({merged:true,head:{sha:artifact.identity},base:{ref:'main'},merge_commit_sha:'merged-head',html_url:'https://github.com/test-owner/product/pull/12'});if(args[1]?.includes('/compare/'))return JSON.stringify({status:'ahead'});return undefined;});
  await expect(delivery.merge(actor,{productId:project.productId!,artifactId:artifact.id})).rejects.toMatchObject({code:'workspace_advance_required'});expect(store.need('projects',project.id).delivery.state).toBe('merged');expect(vi.mocked(workspaces.git).mock.calls.some(([,args])=>args.includes('reset'))).toBe(false);expect(store.need('projects',project.id).baseCommit).toBe('base');
 });
});


describe('late workspace advancement ownership',()=>{
 it.each(['pause','dirty'] as const)('preserves workspace when %s happens during merge fetch',async fault=>{
  store.update('projects',project.id,{delivery:{state:'awaiting_checks',prNumber:12,artifactId:artifact.id,identity:artifact.identity,publicationActionId:'observed-publication'}});
  let fetchReached!:()=>void,finishFetch!:()=>void;const started=new Promise<void>(resolve=>{fetchReached=resolve;}),wait=new Promise<void>(resolve=>{finishFetch=resolve;});
  providerReads(async(file,args)=>{
   if(file==='git'&&args.includes('fetch')){fetchReached();await wait;return '';}
   if(file!=='gh')return undefined;
   if(args[0]==='pr')return JSON.stringify({number:12,headRefOid:artifact.identity,baseRefName:'main',state:'MERGED'});
   if(args[1]?.endsWith('/pulls/12'))return JSON.stringify({merged:true,head:{sha:artifact.identity},base:{ref:'main'},merge_commit_sha:'observed-merge',html_url:'https://github.com/test-owner/product/pull/12'});
   if(args[1]?.includes('/compare/'))return JSON.stringify({status:'ahead'});return undefined;
  });
  const pending=delivery.merge(actor,{productId:project.productId!,artifactId:artifact.id});const observed=pending.catch(error=>error);await started;
  if(fault==='pause')store.command(owner,{type:'control',action:'pause'});else vi.mocked(workspaces.clean).mockResolvedValue(false);
  finishFetch();expect(await observed).toBeInstanceOf(Error);expect(vi.mocked(workspaces.git).mock.calls.some(([,args])=>args.includes('reset'))).toBe(false);expect(store.need('projects',project.id).baseCommit).toBe('base');expect(store.need('projects',project.id).delivery.state).toBe('merged');
 });
});

describe('action-time closure preflight',()=>{
 it('rechecks issue scope after awaited cost reads before publishing a closing PR',async()=>{
  providerReads();const issue=await delivery.readIssue(project.productId!,7),review=store.list('reviews')[0]!;store.update('reviews',review.id,{issueAcceptance:{...issue,artifactId:artifact.id,artifactIdentity:artifact.identity,reviewerId:review.employeeId,runId:review.runId}});
  let changed=false;providerReads(async(file,args)=>{if(file==='git'&&args.includes('fetch')){await Promise.resolve();changed=true;return '';}if(file==='gh'&&args[1]==='repos/test-owner/product/issues/7')return JSON.stringify({number:7,title:issue.title,body:issue.body+(changed?'\nNew acceptance added during provider preflight':''),state:'open'});return undefined;});
  await expect(delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Complete issue outcome',body:'Actual reviewed outcome',issueNumber:7,closeIssue:true})).rejects.toMatchObject({code:'issue_changed'});expect(sends.filter(send=>send.includes('POST'))).toEqual([]);expect(store.list('actions').find(action=>action.kind==='pull_request')?.status).toBe('prepared');
 });
 it('rechecks remote closing text after merge cost preflight and never sends a stale-safe merge',async()=>{
  store.update('projects',project.id,{delivery:{state:'awaiting_checks',prNumber:12,artifactId:artifact.id,identity:artifact.identity}});let changed=false;
  providerReads(async(file,args)=>{if(file==='git'&&args.includes('fetch')){changed=true;return '';}if(file==='gh'&&args[0]==='pr')return JSON.stringify({number:12,headRefOid:artifact.identity,baseRefName:'main',state:'OPEN',title:'Partial outcome',body:changed?'Closes #777':'A useful partial outcome',mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}]});return undefined;});
  await expect(delivery.merge(actor,{productId:project.productId!,artifactId:artifact.id})).rejects.toMatchObject({code:'closing_syntax_denied'});expect(sends.filter(send=>send.includes('PUT'))).toEqual([]);expect(store.list('actions').find(action=>action.kind==='merge')?.status).toBe('prepared');
 });
});


it('rejects closing directives injected through generated reviewer identity text',async()=>{
 const reviewer=store.list('reviews')[0]!;store.update('employees',reviewer.employeeId,{name:'Closes #999'});providerReads();await expect(delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Safe caller title',body:'Safe caller body'})).rejects.toMatchObject({code:'closing_syntax_denied'});expect(sends.filter(send=>send.includes('POST'))).toEqual([]);expect(store.list('actions').find(action=>action.kind==='pull_request')?.status).toBe('prepared');
});


const versionWorkflow=workflow.replace('    runs-on: ubuntu-latest','    env:\n      WALK_RELEASE_VERSION: v6.3.3\n      UNCHANGED: keep\n    runs-on: ubuntu-latest');
describe('bounded WalkLang release-version workflow qualification',()=>{
 it.each(['v6.3.3','v6.4.1','v7.0.0-rc.1+build.2'])('qualifies only a valid existing release literal %s with original source hashes',version=>{
  const result=qualifyWalkLangReleaseVersion(versionWorkflow,versionWorkflow.replace('v6.3.3',version));expect(result).toMatchObject({kind:'walklang-release-version-only',location:'jobs.test.env.WALK_RELEASE_VERSION',from:'v6.3.3',to:version});expect(result.beforeSha256).toMatch(/^[a-f0-9]{64}$/);expect(result.afterSha256).toMatch(/^[a-f0-9]{64}$/);
 });
 it.each([
  ['runner',versionWorkflow.replace('ubuntu-latest','macos-15-large')],
  ['other standard runner',versionWorkflow.replace('ubuntu-latest','macos-latest')],
  ['action version',versionWorkflow.replace('actions/checkout@v4','actions/checkout@v5')],
  ['action identity',versionWorkflow.replace('actions/checkout@v4','actions/setup-node@v4')],
  ['step',versionWorkflow.replace('npm test','npm run other')],
  ['other env',versionWorkflow.replace('UNCHANGED: keep','UNCHANGED: changed')],
  ['new env',versionWorkflow.replace('UNCHANGED: keep','UNCHANGED: keep\n      ADDED: true')],
  ['permissions',versionWorkflow+'permissions: write-all\n'],
  ['job',versionWorkflow+'  added:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo new\n'],
  ['expression',versionWorkflow.replace('v6.3.3','${{ vars.RELEASE_VERSION }}')],
  ['shell',versionWorkflow.replace('v6.3.3','v6.4.1; echo unsafe')],
  ['nonsemantic version',versionWorkflow.replace('v6.3.3','v06.4.1')],
  ['invalid prerelease',versionWorkflow.replace('v6.3.3','v6.4.1-01')],
  ['duplicate key',versionWorkflow.replace('WALK_RELEASE_VERSION: v6.3.3','WALK_RELEASE_VERSION: v6.3.3\n      WALK_RELEASE_VERSION: v6.4.1')],
 ])('denies %s changes even alongside a release version update',(_name,changed)=>{
  expect(()=>qualifyWalkLangReleaseVersion(versionWorkflow,changed.replace('v6.3.3','v6.4.1'))).toThrow(/Only an existing/);
 });
 it('does not let an alias propagate the approved scalar change into another env location',()=>{
  const before=versionWorkflow.replace('    env:','    env: &shared')+'  other:\n    env: *shared\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';expect(()=>qualifyWalkLangReleaseVersion(before,before.replace('v6.3.3','v6.4.1'))).toThrow(/Only an existing/);
 });
 function changedWorkflow(paths='.github/workflows/ci.yml'){
  vi.mocked(workspaces.git).mockImplementation(async(_project,args)=>args.includes('diff')?paths:args.includes('ls-tree')?`100644 blob ${'d'.repeat(40)}\t.github/workflows/ci.yml`:'');
  vi.spyOn(delivery as any,'workflowSource').mockImplementation(async(_mirror:any,commit:any)=>commit===artifact.identity?versionWorkflow.replace('v6.3.3','v6.4.1'):versionWorkflow);
  providerReads(async(file,args)=>file==='git'&&args.includes('show')?versionWorkflow:undefined);
 }
 it('retains the exact artifact and live default-head qualification on both external action cost proofs',async()=>{
  changedWorkflow();await delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Align existing release input',body:'Actual independently reviewed literal correction'});
  expect(sends.filter(send=>send.includes('push'))).toHaveLength(1);expect(sends.filter(send=>send.includes('POST'))).toHaveLength(1);
  for(const action of store.list('actions')){expect(action.costPreflight).toMatchObject({artifactId:artifact.id,artifactIdentity:artifact.identity,defaultBranchHead:defaultHead,visibility:'public',workflowQualification:{reviewed:{referenceCommit:'base',kind:'walklang-release-version-only',from:'v6.3.3',to:'v6.4.1'},currentDefault:{referenceCommit:defaultHead,kind:'walklang-release-version-only',from:'v6.3.3',to:'v6.4.1'}}});expect(action.costEvidence).toContain(artifact.identity);expect(action.costEvidence).toContain(defaultHead);}
 });
 it.each(['.github/workflows/ci.yml\n.github/workflows/new.yml','".github/workflows/quoted-file.yml"','.github/workflows/renamed.yml'])('denies added or arbitrary workflow file sets: %s',paths=>{
  return (async()=>{changedWorkflow(paths);await expect(delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Unqualified workflow change',body:'Actual fixture'})).rejects.toMatchObject({code:'cost_unconfirmed'});expect(sends).toEqual([]);expect(store.list('actions')).toHaveLength(0);})();
 });
 it('denies other products and file mode changes without dispatch',async()=>{
  changedWorkflow();store.update('products',project.productId!,{name:'OpenJob'});await expect(delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Version input',body:'Fixture'})).rejects.toThrow(/only the existing WalkLang/);store.update('products',project.productId!,{name:'WalkLang'});vi.mocked(workspaces.git).mockImplementation(async(_project,args)=>args.includes('diff')?'.github/workflows/ci.yml':`100755 blob ${'d'.repeat(40)}\t.github/workflows/ci.yml`);await expect(delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Version input',body:'Fixture'})).rejects.toThrow(/regular file/);expect(sends).toEqual([]);
 });
 it('rejects a standard-but-different live default workflow rather than qualifying only the old baseline',async()=>{
  changedWorkflow();vi.spyOn(delivery as any,'workflowSource').mockImplementation(async(_mirror:any,commit:any)=>commit===artifact.identity?versionWorkflow.replace('v6.3.3','v6.4.1'):commit===defaultHead?versionWorkflow.replace('UNCHANGED: keep','UNCHANGED: moved'):versionWorkflow);
  await expect(delivery.deliver(actor,{productId:project.productId!,artifactId:artifact.id,title:'Version input',body:'Fixture'})).rejects.toThrow(/Only an existing/);expect(sends).toEqual([]);
 });
});

describe('original workflow source capture',()=>{
 function repository(content:string){const workspace=join(root,'raw-workflow');mkdirSync(join(workspace,'.github/workflows'),{recursive:true});writeFileSync(join(workspace,'.github/workflows/ci.yml'),content);const git=(args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','user.name=Workflow fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false',...args],{cwd:workspace,env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8'}).trim();git(['init','--quiet']);git(['add','.github/workflows/ci.yml']);git(['commit','--quiet','-m','Actual source capture fixture']);return {mirror:join(workspace,'.git'),commit:git(['rev-parse','HEAD'])};}
 it('reads all original bytes including trailing whitespace and a synthetic redaction-shaped canary',async()=>{
  const source=versionWorkflow+'\n# ghp_SYNTHETIC_WORKFLOW_CAPTURE_CANARY\n\n',fixture=repository(source);expect(await (delivery as any).workflowSource(fixture.mirror,fixture.commit,'.github/workflows/ci.yml')).toBe(source);
 });
 it('fails closed when full source exceeds the bound instead of qualifying a truncated prefix',async()=>{
  const fixture=repository(versionWorkflow+'# oversized fixture '.repeat(20000));await expect((delivery as any).workflowSource(fixture.mirror,fixture.commit,'.github/workflows/ci.yml')).rejects.toMatchObject({code:'cost_unconfirmed'});
 });
});
