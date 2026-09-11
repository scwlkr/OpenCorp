import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CompanyStore} from '../src/storage/store.js';
import {Scheduler} from '../src/scheduler/scheduler.js';
import {CorporateBroker} from '../src/tools/broker.js';
import type {LocalRuntime} from '../src/runtime/index.js';

const owner={kind:'owner'} as const;
const model={sourceAlias:'fixture-local-startup',alias:'fixture-startup',artifactIdentity:'fixture-digest',capabilities:['tools'],local:true,available:true};
let root:string,store:CompanyStore,scheduler:Scheduler,install:ReturnType<typeof vi.fn>,reconcile:ReturnType<typeof vi.spyOn>;
beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-startup-'));store=new CompanyStore(root);store.bootstrap();store.command(owner,{type:'control',action:'start'});
 install=vi.fn();const runtime={installModels:install,recoverTools:async()=>({status:'absent',jobs:[]}),stop:vi.fn(async()=>{}),cancel:vi.fn(async()=>{})};
 scheduler=new Scheduler(store,runtime as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');await scheduler.recover();
 reconcile=vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);
});
afterEach(async()=>{await scheduler.shutdown();store.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
function pendingInstall(){let resolve!:(models:any[])=>void,reject!:(error:Error)=>void;const promise=new Promise<any[]>((done,fail)=>{resolve=done;reject=fail;});install.mockReturnValueOnce(promise);return {resolve,reject};}
async function control(action:'pause'|'stop'){store.command(owner,{type:'control',action});await scheduler.pause(action==='stop');}

describe('intentional startup cancellation reporting',()=>{
 it.each([['pause',false],['pause',true],['stop',false],['stop',true]] as const)('does not report a superseded %s startup as Owner Attention (quick resume=%s)',async(action,resume)=>{
  const deferred=pendingInstall(),tick=scheduler.tick();expect(install).toHaveBeenCalledOnce();await control(action);
  if(resume){store.command(owner,{type:'control',action:'resume'});scheduler.start();}
  deferred.reject(new Error(action==='stop'?'Owned Ollama stopped during startup':'TypeError: fetch failed'));await tick;
  expect(store.list('attention')).toEqual([]);expect(store.eventLog().filter(event=>event.type==='scheduler.error')).toEqual([]);expect(store.eventLog().filter(event=>event.type==='models.startup_cancelled')).toHaveLength(1);expect(reconcile).not.toHaveBeenCalled();
  if(!resume)store.command(owner,{type:'control',action:'resume'});install.mockResolvedValueOnce([model]);await scheduler.tick();
  expect(install).toHaveBeenCalledTimes(2);expect(store.need('models',model.sourceAlias).artifactIdentity).toBe(model.artifactIdentity);expect(reconcile).toHaveBeenCalledOnce();
 });
 it('does not publish late successful model readiness after stop, even when immediately resumed',async()=>{
  const deferred=pendingInstall(),tick=scheduler.tick();await control('stop');store.command(owner,{type:'control',action:'resume'});scheduler.start();deferred.resolve([model]);await tick;
  expect(store.get('models',model.sourceAlias)).toBeUndefined();expect(store.eventLog().filter(event=>event.type==='models.ready')).toEqual([]);expect(reconcile).not.toHaveBeenCalled();
  install.mockResolvedValueOnce([model]);await scheduler.tick();expect(install).toHaveBeenCalledTimes(2);expect(store.eventLog().filter(event=>event.type==='models.ready')).toHaveLength(1);expect(reconcile).toHaveBeenCalledOnce();
 });
 it('reports a genuine initialization failure in the current lifecycle, including after a cancelled attempt',async()=>{
  const deferred=pendingInstall(),tick=scheduler.tick();await control('pause');store.command(owner,{type:'control',action:'resume'});deferred.reject(new Error('Cancelled startup transport'));await tick;
  install.mockRejectedValueOnce(new Error('Actual current initialization fault'));await scheduler.tick();
  expect(store.list('attention')).toMatchObject([{kind:'runtime',status:'open',detail:'Error: Actual current initialization fault'}]);expect(store.eventLog().filter(event=>event.type==='scheduler.error').map(event=>event.payload.error)).toEqual(['Error: Actual current initialization fault']);expect(reconcile).not.toHaveBeenCalled();
 });
});
