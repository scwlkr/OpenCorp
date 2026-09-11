import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as files from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { OwnedOllama } from '../src/runtime/ollama.js';
import { MODEL_ALIASES } from '../src/runtime/types.js';
import * as processes from '../src/runtime/processes.js';

vi.mock('node:fs/promises',async importOriginal=>({...await importOriginal<typeof import('node:fs/promises')>()}));
vi.mock('node:fs',async importOriginal=>({...await importOriginal<typeof import('node:fs')>()}));

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const descriptor=(value:string)=>({digest:`sha256:${hash(value)}`,size:Buffer.byteLength(value)});
const manifestPath=(root:string,alias:string)=>join(root,'manifests/registry.ollama.ai/library',...alias.split(':'));
const blobPath=(root:string,value:string)=>join(root,'blobs',`sha256-${hash(value)}`);
let root:string,source:string,ollama:OwnedOllama;
const sourceAlias=MODEL_ALIASES['qwen-main'],alias='opencorp-qwen-main-16384:latest',weight='fixture model weight',config='fixture config',params='{"num_ctx":16384,"num_predict":4096,"temperature":0.2}';
const sourceRaw=JSON.stringify({layers:[descriptor(weight)],config:descriptor(config)}),profileRaw=JSON.stringify({layers:[descriptor(weight),descriptor(params)],config:descriptor(config)});
async function writeManifest(store:string,name:string,raw:string){const path=manifestPath(store,name);await files.mkdir(dirname(path),{recursive:true});await files.writeFile(path,raw);}
async function imported(){await expect(ollama.start()).rejects.toThrow('fixture service boundary');}
beforeEach(async()=>{
 root=await files.mkdtemp(join(tmpdir(),'opencorp-owned-blobs-'));source=join(root,'source-models');ollama=new OwnedOllama({dataRoot:join(root,'private'),modelStore:source});
 await files.mkdir(join(source,'blobs'),{recursive:true});for(const content of [weight,config,params])await files.writeFile(blobPath(source,content),content);await writeManifest(source,sourceAlias,sourceRaw);
 vi.spyOn(processes,'spawnOwned').mockRejectedValue(new Error('fixture service boundary'));
});
afterEach(async()=>{await ollama.stop();vi.restoreAllMocks();vi.unstubAllGlobals();await files.rm(root,{recursive:true,force:true});});

function inventory(changeOnCreate=false){
 vi.spyOn(ollama,'start').mockResolvedValue();
 let raw=profileRaw;
 const fetch=vi.fn(async(_url:string,init?:RequestInit)=>{
  const path=new URL(_url).pathname;
  if(path==='/api/tags')return Response.json({models:[{name:sourceAlias,digest:hash(sourceRaw),size:weight.length},{name:alias,digest:hash(raw),size:weight.length}]});
  if(path==='/api/create'){if(changeOnCreate)raw=JSON.stringify({...JSON.parse(profileRaw),changed:true});await files.writeFile(blobPath(ollama.modelStore,params),params);await writeManifest(ollama.modelStore,alias,raw);return Response.json({status:'success'});}
  if(path==='/api/show')return Response.json({template:'fixture local template',parameters:'num_ctx 16384\nnum_predict 4096\ntemperature 0.2',capabilities:['tools']});
  throw new Error(`Unexpected provider call ${path}: ${init?.method}`);
 });
 ollama.url='http://127.0.0.1:1';vi.stubGlobal('fetch',fetch);return {fetch,changeProfile:()=>{raw=JSON.stringify({...JSON.parse(profileRaw),changed:true});}};
}
async function profile(){await writeManifest(ollama.modelStore,alias,profileRaw);await files.writeFile(join(ollama.root,'qwen-main-16384.source'),hash(sourceRaw));}

describe('owned Ollama blob isolation',()=>{
 it('migrates only the legacy link, retaining private generated layers and unrelated global files/aliases',async()=>{
  await files.mkdir(ollama.modelStore,{recursive:true});await files.symlink(join(source,'blobs'),join(ollama.modelStore,'blobs'));await profile();await writeManifest(source,'unrelated:latest',sourceRaw);await files.writeFile(join(source,'blobs','unrelated'),'other application');
  const sourceNames=await files.readdir(join(source,'blobs'));await imported();
  expect((await files.lstat(join(ollama.modelStore,'blobs'))).isDirectory()).toBe(true);expect((await files.lstat(join(ollama.modelStore,'blobs'))).isSymbolicLink()).toBe(false);
  for(const content of [weight,config,params])expect(await files.readFile(blobPath(ollama.modelStore,content),'utf8')).toBe(content);
  expect(await files.readFile(manifestPath(ollama.modelStore,alias),'utf8')).toBe(profileRaw);expect(await files.readFile(manifestPath(source,'unrelated:latest'),'utf8')).toBe(sourceRaw);
  expect(await files.readdir(join(source,'blobs'))).toEqual(sourceNames);await expect(files.stat(join(ollama.modelStore,'blobs','unrelated'))).rejects.toMatchObject({code:'ENOENT'});await expect(files.stat(manifestPath(ollama.modelStore,'unrelated:latest'))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('survives source pruning and never lets owned pruning erase source blobs',async()=>{
  await imported();await files.unlink(blobPath(source,weight));expect(await files.readFile(blobPath(ollama.modelStore,weight),'utf8')).toBe(weight);
  await files.unlink(blobPath(ollama.modelStore,config));expect(await files.readFile(blobPath(source,config),'utf8')).toBe(config);
  await imported();expect(await files.readFile(blobPath(ollama.modelStore,weight),'utf8')).toBe(weight);expect(await files.readFile(blobPath(ollama.modelStore,config),'utf8')).toBe(config);
 });
 it('refuses an unexpected blob-directory link without altering either target',async()=>{
  const other=join(root,'unrelated');await files.mkdir(other);await files.writeFile(join(other,'retained'),'keep');await files.mkdir(ollama.modelStore,{recursive:true});await files.symlink(other,join(ollama.modelStore,'blobs'));
  await expect(ollama.start()).rejects.toThrow('Unexpected owned blob directory symlink');expect(await files.readlink(join(ollama.modelStore,'blobs'))).toBe(other);expect(await files.readFile(join(other,'retained'),'utf8')).toBe('keep');expect(processes.spawnOwned).not.toHaveBeenCalled();
 });
 it('keeps the legacy link untouched while prior process ownership is uncertain',async()=>{
  await files.mkdir(ollama.modelStore,{recursive:true});await files.symlink(join(source,'blobs'),join(ollama.modelStore,'blobs'));await files.writeFile(join(ollama.root,'process.json'),'{}');vi.spyOn(processes,'recoverOwnedReceipt').mockResolvedValue({status:'uncertain'} as any);
  await expect(ollama.start()).rejects.toThrow('requires reconciliation');expect((await files.lstat(join(ollama.modelStore,'blobs'))).isSymbolicLink()).toBe(true);expect(processes.spawnOwned).not.toHaveBeenCalled();
 });
 it.each(['unsafe digest','missing source','symlink source'])('refuses %s source blobs before service admission',async scenario=>{
  if(scenario==='unsafe digest')await writeManifest(source,sourceAlias,JSON.stringify({layers:[{digest:'../../outside',size:1}],config:descriptor(config)}));
  else {await files.unlink(blobPath(source,weight));if(scenario==='symlink source')await files.symlink(blobPath(source,config),blobPath(source,weight));}
  await expect(ollama.start()).rejects.toThrow();expect(processes.spawnOwned).not.toHaveBeenCalled();
 });
 it('cancels a cross-filesystem copy without publishing a partial blob or launching service',async()=>{
  vi.spyOn(files,'link').mockRejectedValue(Object.assign(new Error('cross filesystem'),{code:'EXDEV'}));let entered!:()=>void;const reached=new Promise<void>(resolve=>{entered=resolve;}),stream=new PassThrough();vi.spyOn(fs,'createReadStream').mockImplementation(()=>{entered();return stream as unknown as fs.ReadStream;});
  const started=ollama.start().then(()=>null,error=>error);await reached;stream.write('partial');await ollama.stop();expect(await started).toBeInstanceOf(Error);
  expect(stream.destroyed).toBe(true);expect(await files.readdir(join(ollama.modelStore,'blobs'))).toEqual([]);expect(await files.readFile(blobPath(source,weight),'utf8')).toBe(weight);expect(processes.spawnOwned).not.toHaveBeenCalled();
 });
 it('recreates missing generated metadata with the same actual profile identity and no download',async()=>{
  await imported();await profile();await files.writeFile(blobPath(ollama.modelStore,params),params);const api=inventory(),before=(await ollama.models())[0];await files.unlink(blobPath(ollama.modelStore,params));await files.rm(blobPath(source,params),{force:true});
  const after=(await ollama.models())[0];expect(after).toEqual(before);expect(await files.readFile(blobPath(ollama.modelStore,params),'utf8')).toBe(params);
  const creates=api.fetch.mock.calls.filter(([url])=>url.endsWith('/api/create'));expect(creates).toHaveLength(1);expect(JSON.parse(creates[0][1]!.body as string)).toEqual({model:alias,from:sourceAlias,parameters:{num_ctx:16384,num_predict:4096,temperature:0.2},stream:false});expect(api.fetch.mock.calls.every(([url])=>!url.includes('/api/pull'))).toBe(true);
 });
 it('rejects a repair whose recreated profile digest changes',async()=>{
  await imported();await profile();const api=inventory(true);await expect(ollama.models()).rejects.toThrow('Recreated local profile identity changed');expect(api.fetch.mock.calls.filter(([url])=>url.endsWith('/api/create'))).toHaveLength(1);
 });
 it.each(['missing source','changed identity'])('does not claim repaired identity for %s',async scenario=>{
  await imported();await profile();const api=inventory();if(scenario==='missing source')await files.unlink(blobPath(ollama.modelStore,weight));else api.changeProfile();
  await expect(ollama.models()).rejects.toThrow();expect(api.fetch.mock.calls.some(([url])=>url.endsWith('/api/create'))).toBe(false);
 });
});
