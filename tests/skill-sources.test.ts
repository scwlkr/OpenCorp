import { afterEach, beforeEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyStore } from '../src/storage/store.js';
import { assertRetainedSourceLicense } from '../src/core/source-license.js';
import { SkillSources } from '../src/tools/skill-sources.js';
import type { Actor } from '../src/core/types.js';
let root:string,store:CompanyStore,actor:Actor,calls:string[],sources:SkillSources;
const commit='a'.repeat(40),license='MIT License\nPermission is hereby granted, free of charge',content='Source instructions\n'.repeat(1500);
async function fetchFixture(url:string){calls.push(url);if(url.endsWith('/commits/HEAD'))return JSON.stringify({sha:commit});if(url.includes('/git/trees/'))return JSON.stringify({tree:[{type:'blob',path:'skills/useful/SKILL.md'},{type:'blob',path:'LICENSE'}]});if(url.endsWith('/LICENSE'))return license;if(url.endsWith('/SKILL.md'))return content;return 'Discovery source';}
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-skills-'));store=new CompanyStore(root);store.bootstrap();store.update('company',store.company.id,{state:'running'});const employee=store.list('employees').find(e=>store.level(e.id)==='ceo')!,run=store.put('runs',{employeeId:employee.id,status:'running',tokenRevoked:false,policyRevision:store.policy.revision});actor={kind:'employee',employeeId:employee.id,runId:run.id,policyRevision:store.policy.revision};calls=[];sources=new SkillSources(store,fetchFixture);});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
async function imported(){const catalog=await sources.discover(actor,{source:'skills'});return sources.import(actor,{catalogId:catalog.catalogId,path:'skills/useful/SKILL.md',adaptation:'Keep local useful instructions'});}
test('pins discovered sources and license, requires all source pages, and reuses exact imports after restart',async()=>{
 const source=await imported();expect(calls).toContain('https://www.skills.sh/docs');expect(source.commit).toBe(commit);expect(source.sha256).toBe(createHash('sha256').update(content).digest('hex'));expect(source.inspectionComplete).toBe(false);
 sources.read(source.id,24000,actor);expect(store.need('runs',(actor as any).runId).skillInspections[source.id].complete).toBe(false);
 expect(sources.read(source.id,12000,actor).inspectionComplete).toBe(true);expect(readFileSync(join(source.sourcePath,'..','LICENSE'),'utf8')).toBe(license);
 const before=calls.length;store.close();store=new CompanyStore(root);sources=new SkillSources(store,fetchFixture);expect((await imported()).id).toBe(source.id);expect(calls).toHaveLength(before);
});
test('rejects modified source/license and source file escapes',async()=>{
 const source=await imported();writeFileSync(source.sourcePath,'modified');expect(()=>sources.read(source.id,0,actor)).toThrow(/hash changed/);writeFileSync(source.sourcePath,content);writeFileSync(join(source.sourcePath,'..','LICENSE'),'changed license');expect(()=>sources.read(source.id)).toThrow(/hash changed/);
 const outside=join(root,'outside.txt');writeFileSync(outside,content);rmSync(source.sourcePath);symlinkSync(outside,source.sourcePath);expect(()=>sources.read(source.id)).toThrow(/owned import/);
});
test('revocation during a source fetch prevents persistent catalog creation',async()=>{
 sources=new SkillSources(store,async url=>{const result=await fetchFixture(url);if(url.includes('/git/trees/'))store.update('runs',(actor as any).runId,{tokenRevoked:true});return result;});
 await expect(sources.discover(actor,{source:'agency'})).rejects.toThrow(/revoked/);expect(store.list('experiences').filter(r=>r.kind==='skill-catalog')).toHaveLength(0);
});
test('incompatible license and noncatalog path never create imported sources',async()=>{
 const catalog=await sources.discover(actor,{source:'agency'});await expect(sources.import(actor,{catalogId:catalog.catalogId,path:'../credentials',adaptation:'bad'})).rejects.toThrow(/catalog path/);
 sources=new SkillSources(store,async url=>url.endsWith('/LICENSE')?'All rights reserved':fetchFixture(url));await expect(sources.import(actor,{catalogId:catalog.catalogId,path:'skills/useful/SKILL.md',adaptation:'Useful'})).rejects.toThrow(/MIT sources/);expect(store.list('experiences').filter(r=>r.kind==='skill-source')).toHaveLength(0);
});

test('revocation during import prevents saving sources or source-inspection evidence',async()=>{
 const catalog=await sources.discover(actor,{source:'agency'});
 sources=new SkillSources(store,async url=>{const result=await fetchFixture(url);if(url.endsWith('/LICENSE'))store.update('runs',(actor as any).runId,{tokenRevoked:true});return result;});
 await expect(sources.import(actor,{catalogId:catalog.catalogId,path:'skills/useful/SKILL.md',adaptation:'Useful local work'})).rejects.toThrow(/revoked/);
 expect(store.list('experiences').filter(r=>r.kind==='skill-source')).toHaveLength(0);expect(store.need('runs',(actor as any).runId).skillInspections).toBeUndefined();
});

 test('rejects restrictive scoped licenses even when the root license is MIT',async()=>{
 const catalog=await sources.discover(actor,{source:'skills'});store.update('experiences',catalog.catalogId,{licensePaths:['LICENSE','skills/useful/LICENSE.md']});
 sources=new SkillSources(store,async url=>url.endsWith('/skills/useful/LICENSE.md')?'All rights reserved':fetchFixture(url));
 await expect(sources.import(actor,{catalogId:catalog.catalogId,path:'skills/useful/SKILL.md',adaptation:'Use source'})).rejects.toThrow(/MIT sources/);
 expect(store.list('experiences').filter(r=>r.kind==='skill-source')).toHaveLength(0);
});

test('refreshes legacy catalog license metadata at its existing immutable revision',async()=>{
 const catalog=await sources.discover(actor,{source:'skills'});store.update('experiences',catalog.catalogId,{licensePaths:null});
 sources=new SkillSources(store,async url=>url.includes('/git/trees/')?JSON.stringify({tree:[{type:'blob',path:'skills/useful/LICENSE.md'}]}):url.endsWith('/skills/useful/LICENSE.md')?'All rights reserved':fetchFixture(url));
 await expect(sources.import(actor,{catalogId:catalog.catalogId,path:'skills/useful/SKILL.md',adaptation:'Use source'})).rejects.toThrow(/MIT sources/);
 expect(store.need('experiences',catalog.catalogId).commit).toBe(commit);
});

test('searches actual skills.sh competencies and pins a selected returned GitHub source',async()=>{
 sources=new SkillSources(store,async url=>{if(url.includes('/api/search?')){calls.push(url);return JSON.stringify({skills:[{source:'vercel-labs/agent-skills',name:'react',skillId:'react'},{source:'example/typescript-skills',name:'types',skillId:'types'}]});}return fetchFixture(url);});
 const catalog=await sources.discover(actor,{source:'skills',query:'typescript',repository:'example/typescript-skills'});
 expect(catalog.repository).toBe('example/typescript-skills');expect(catalog.commit).toBe(commit);expect(catalog.paths).toContain('skills/useful/SKILL.md');expect(catalog.matches).toHaveLength(2);
 expect(calls).toContain('https://www.skills.sh/api/search?q=typescript&limit=20');expect(calls).toContain(`https://api.github.com/repos/example/typescript-skills/git/trees/${commit}?recursive=1`);
 const source=await sources.import(actor,{catalogId:catalog.catalogId,path:'skills/useful/SKILL.md',adaptation:'TypeScript practice for a company employee'});expect(source.repository).toBe('example/typescript-skills');expect(source.discoveryUrl).toContain('/api/search?');
 const count=calls.length;await expect(sources.discover(actor,{source:'skills',query:'typescript',repository:'unlisted/repository'})).rejects.toThrow(/returned by this exact/);expect(calls).toHaveLength(count);
});
test('search results cannot redirect managed imports to arbitrary hosts or traversal repositories',async()=>{
 sources=new SkillSources(store,async()=>JSON.stringify({skills:[{source:'https://evil.example/skills',name:'evil'},{source:'owner/../secret',name:'escape'}]}));
 await expect(sources.discover(actor,{source:'skills',query:'typescript'})).rejects.toThrow(/No GitHub skill sources/);expect(store.list('experiences').filter(r=>r.kind==='skill-catalog')).toHaveLength(0);
});
test('uses actual root LICENSE.md and fails closed when reuse rights are absent',async()=>{
 const catalog=await sources.discover(actor,{source:'agency'});store.update('experiences',catalog.catalogId,{licensePaths:['LICENSE.md']});
 sources=new SkillSources(store,async url=>{if(url.endsWith('/LICENSE.md')){calls.push(url);return license;}return fetchFixture(url);});
 await sources.import(actor,{catalogId:catalog.catalogId,path:'skills/useful/SKILL.md',adaptation:'Useful skill'});expect(calls.some(url=>url.endsWith('/LICENSE.md'))).toBe(true);expect(calls.some(url=>url.endsWith('/LICENSE'))).toBe(false);
 const other=await sources.discover(actor,{source:'skills'});store.update('experiences',other.catalogId,{licensePaths:[]});await expect(sources.import(actor,{catalogId:other.catalogId,path:'skills/useful/SKILL.md',adaptation:'No rights'})).rejects.toThrow(/No applicable upstream license/);
});

test('repeat imports retain concise same-run inspection evidence without replacing original adaptation',async()=>{
 const source=await imported();expect(source).toHaveProperty('content');expect(source.inspectionComplete).toBe(false);
 sources.read(source.id,12000,actor);sources.read(source.id,24000,actor);
 const catalog=await sources.discover(actor,{source:'skills'});
 const repeated=await sources.import(actor,{catalogId:catalog.catalogId,path:'skills/useful/SKILL.md',adaptation:'A new proposed adaptation must not silently overwrite the original'});
 expect(repeated).toMatchObject({id:source.id,sha256:source.sha256,inspectionComplete:true,reused:true,contentOmitted:true,requestedAdaptationApplied:false,nextCall:{tool:'skill_read',arguments:{sourceId:source.id,offset:0}}});
 expect(repeated).not.toHaveProperty('content');expect(JSON.stringify(repeated).length).toBeLessThan(2200);
 expect(store.need('experiences',source.id).adaptation).toBe('Keep local useful instructions');
 expect(sources.read(source.id,0,actor).content).toBe(content.slice(0,12000));
 writeFileSync(source.sourcePath,'changed');await expect(sources.import(actor,{catalogId:catalog.catalogId,path:'skills/useful/SKILL.md',adaptation:'Existing source'})).rejects.toThrow(/hash changed/);
});

test('another run must actually receive every source page again',async()=>{
 const source=await imported();sources.read(source.id,12000,actor);sources.read(source.id,24000,actor);
 const original=store.need('runs',(actor as any).runId),next=store.put('runs',{...original,id:undefined,skillInspections:undefined});
 const nextActor={...actor,runId:next.id} as Actor,catalog=await sources.discover(nextActor,{source:'skills'});
 const repeated=await sources.import(nextActor,{catalogId:catalog.catalogId,path:'skills/useful/SKILL.md',adaptation:'Read for another actual employee turn'});
 expect(repeated).toHaveProperty('content',content.slice(0,12000));expect(repeated.inspectionComplete).toBe(false);
 expect(store.need('runs',next.id).skillInspections[source.id].complete).toBe(false);
 sources.read(source.id,24000,nextActor);expect(store.need('runs',next.id).skillInspections[source.id].complete).toBe(false);
 expect(sources.read(source.id,12000,nextActor).inspectionComplete).toBe(true);
});

test('invalid import path returns bounded exact catalog suggestions without selecting or fetching a source',async()=>{
 const discovered=await sources.discover(actor,{source:'agency'});
 const exact=['hr-operations/hr-business-partner/SKILL.md','hr-operations/people-analytics/SKILL.md'];
 store.update('experiences',discovered.catalogId,{repository:'borghei/claude-skills',query:'HR workforce planning',paths:['engineering/typescript/SKILL.md',...exact,...Array.from({length:10},(_,i)=>`other/role-${i}/SKILL.md`)]});
 const before=calls.length;
 let error:Error|undefined;try{await sources.import(actor,{catalogId:discovered.catalogId,path:'skills/hr-workforce-planning/SKILL.md',adaptation:'Locally adapt workforce planning'});}catch(caught){error=caught as Error;}
 expect(error?.message).toContain(discovered.catalogId);expect(error?.message).toContain('borghei/claude-skills');expect(error?.message).toContain(JSON.stringify(exact[0]));expect(error?.message).toContain(JSON.stringify(exact[1]));expect(error?.message.indexOf(exact[0])).toBeLessThan(error!.message.indexOf('engineering/typescript'));
 const suggestions=JSON.parse(error!.message.match(/Available paths: (\[.*?\])/s)![1]);expect(suggestions).toHaveLength(5);expect(suggestions.every((path:string)=>store.need('experiences',discovered.catalogId).paths.includes(path))).toBe(true);
 expect(error!.message.length).toBeLessThan(3000);expect(calls).toHaveLength(before);expect(store.list('experiences').some(r=>r.kind==='skill-source')).toBe(false);
});

test('agency multiword discovery falls back to ranked actual token matches without manufacturing paths',async()=>{
 const catalog=await sources.discover(actor,{source:'agency'}),paths=['engineering/senior-developer.md','specialized/recruitment-specialist.md','specialized/workforce-planning.md'];
 store.update('experiences',catalog.catalogId,{paths});
 const results=await sources.discover(actor,{source:'agency',query:'Recruitment Workforce Planning Lead'});
 expect(results.partialMatch).toBe(true);expect(results.paths).toEqual(['specialized/workforce-planning.md','specialized/recruitment-specialist.md']);expect(results.commit).toBe(commit);
 expect((await sources.discover(actor,{source:'agency',query:'recruitment'})).paths).toEqual(['specialized/recruitment-specialist.md']);
 expect((await sources.discover(actor,{source:'agency',query:'nonexistent capability'})).paths).toEqual([]);
 expect(store.list('experiences').some(r=>r.kind==='skill-source')).toBe(false);
});

test.each(['---\nlicense: MIT + Commons Clause\n---\nInstructions','---\n  license: MIT + Commons Clause\n---\nInstructions','---\nlicense: Apache-2.0\n---\nInstructions'])('rejects source-level non-MIT declarations before importing bytes',async body=>{
 sources=new SkillSources(store,async url=>url.endsWith('/SKILL.md')?body:fetchFixture(url));
 await expect(imported()).rejects.toMatchObject({code:'license_review_required'});expect(store.list('experiences').filter(r=>r.kind==='skill-source')).toEqual([]);
});
test('retained mismatched license cannot be read or reused despite completed inspection; history remains unchanged',async()=>{
 const source=await imported(),body='---\nlicense: MIT + Commons Clause\n---\nInstructions',sha256=createHash('sha256').update(body).digest('hex');writeFileSync(source.sourcePath,body);
 const retained=store.update('experiences',source.id,{sha256});store.update('runs',(actor as any).runId,{skillInspections:{[source.id]:{sha256,complete:true,ranges:[[0,body.length]]}}});const receipt=store.need('runs',(actor as any).runId).skillInspections;
 expect(()=>sources.read(source.id,0,actor)).toThrow(/plain MIT/);await expect(imported()).rejects.toMatchObject({code:'license_review_required'});
 expect(store.need('experiences',source.id)).toEqual(retained);expect(store.need('runs',(actor as any).runId).skillInspections).toEqual(receipt);expect(readFileSync(source.sourcePath,'utf8')).toBe(body);
});
test('plain MIT frontmatter permits discussion of other licenses but rejects restrictive license additions',async()=>{
 sources=new SkillSources(store,async url=>url.endsWith('/SKILL.md')?'---\nlicense: "MIT"\n---\nCompare Apache and Commons Clause licenses as a research topic.':fetchFixture(url));expect((await imported()).license).toBe('MIT');
 sources=new SkillSources(store,async url=>url.endsWith('/LICENSE')?license+'\nCommons Clause prohibits selling this software.':fetchFixture(url));const catalog=await sources.discover(actor,{source:'agency'});await expect(sources.import(actor,{catalogId:catalog.catalogId,path:'skills/useful/SKILL.md',adaptation:'Local research'})).rejects.toMatchObject({code:'license_review_required'});
});

test('retained eligibility rejects malformed source identities before resolving files',async()=>{
 const source=await imported();expect(()=>assertRetainedSourceLicense(store,{...source,id:'../outside'})).toThrow(/plain MIT/);expect(()=>assertRetainedSourceLicense(store,source)).not.toThrow();
});
