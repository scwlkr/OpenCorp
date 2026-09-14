import { emailConfig, EmailTransport } from './email.js';
import { telegramConfig, TelegramTransport } from './telegram.js';
import { pruneInspections } from '../runtime/inspection.js';
import { createFreePool } from './free-pool-config.js';
import { directFreeConfig } from './direct-free-config.js';
import { openRouterFreeConfig } from './openrouter-config.js';
import { serve } from '@hono/node-server';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, copyFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { CompanyStore } from '../storage/store.js';
import { LocalRuntime } from '../runtime/index.js';
import { CorporateBroker } from '../tools/broker.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { ownerApp, workerApp } from './app.js';
import { defaultDataRoot,ensureDataRoot,writePrivate,preferredOwnerPort } from './paths.js';
import { notifyOwnerRequests } from './owner-notifications.js';
import { redact } from '../tools/process.js';

if(process.versions.node!=='24.20.0')throw new Error(`OpenCorp requires Node 24.20.0, got ${process.versions.node}.`);
const dataRoot=defaultDataRoot();ensureDataRoot(dataRoot);const lockPath=join(dataRoot,'daemon-lock.json');
if(existsSync(lockPath)){const prior=JSON.parse(readFileSync(lockPath,'utf8'));let alive=false;try{process.kill(prior.pid,0);alive=true;}catch{/* Process already absent. */}if(alive){process.stderr.write('An OpenCorp daemon already owns this data directory.\n');process.exit(0);}unlinkSync(lockPath);}
writeFileSync(lockPath,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
const store=new CompanyStore(dataRoot);store.bootstrap();
const freeConfig=openRouterFreeConfig(dataRoot,store.policy.openRouterFreeModels??[]);
if(freeConfig)freeConfig.cooldown={read:()=>store.providerBackoff(),write:value=>store.recordProviderBackoff(value)};
const directConfig=directFreeConfig(dataRoot,store.policy.directFreeModels??[]);
const freePool=createFreePool(dataRoot,{openRouterFree:freeConfig,directFree:directConfig});
store.put('models',freePool.model());
const runtime=new LocalRuntime({dataRoot,localModelAliases:existsSync(join(dataRoot,'local-models.json'))?JSON.parse(readFileSync(join(dataRoot,'local-models.json'),'utf8')):undefined,freePool,openRouterFree:freeConfig,directFree:directConfig,resourceBudget:{maxConcurrentTurns:store.policy.maxInference,maxProductiveTurns:store.policy.maxProductiveTurns??1,productiveArtifactIdentity:store.policy.productiveConcurrencyQualification?.artifactIdentity,...(store.policy.productiveConcurrencyQualification?.mode==='local-remote'?{productiveRemoteModelId:store.policy.productiveConcurrencyQualification.remoteModelId,productiveRemoteArtifactIdentity:store.policy.productiveConcurrencyQualification.remoteArtifactIdentity}:store.policy.productiveConcurrencyQualification?.mode==='local-remotes'?{productiveRemoteProfiles:store.policy.productiveConcurrencyQualification.remoteProfiles,productiveProviderCaps:store.policy.productiveConcurrencyQualification.providerCaps}:{}),maxSocialTurns:Math.max(1,store.policy.maxInference-1),maxLoadedModels:store.policy.maxLoadedModels??Math.min(2,store.policy.maxInference)}});const broker=new CorporateBroker(store,dataRoot);let workerHost='';
const worker=serve({fetch:workerApp(broker,()=>workerHost).fetch,hostname:'127.0.0.1',port:0});
await new Promise<void>((resolve,reject)=>{worker.once('listening',()=>resolve());worker.once('error',reject);});
const workerAddress=worker.address();if(!workerAddress||typeof workerAddress==='string')throw new Error('Worker broker failed to bind loopback.');workerHost=`127.0.0.1:${workerAddress.port}`;
const scheduler=new Scheduler(store,runtime,broker,`http://${workerHost}`);let url='http://127.0.0.1:4310';const app=ownerApp({store,runtime,broker,scheduler,getUrl:()=>url});
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:preferredOwnerPort(dataRoot)});
await new Promise<void>((resolve,reject)=>{server.once('listening',()=>resolve());server.once('error',(error:NodeJS.ErrnoException)=>{if(error.code==='EADDRINUSE'){server.listen(0,'127.0.0.1');}else reject(error);});});
const address=server.address();if(!address||typeof address==='string')throw new Error('Owner API failed to bind loopback.');url=`http://127.0.0.1:${address.port}`;
writePrivate(join(dataRoot,'discovery.json'),JSON.stringify({url,pid:process.pid,startedAt:new Date().toISOString()},null,2));
process.stdout.write(`OpenCorp ${url} (${store.company.state})\n`);
await scheduler.recover();if(store.company.state==='running')scheduler.start();
let telegram:TelegramTransport|undefined;
try{const config=telegramConfig(dataRoot);if(config){telegram=new TelegramTransport(store,config,undefined,(action,messageId)=>scheduler.control(action,messageId));telegram.start();}}catch{store.emit('telegram.unavailable',{detail:'Check private Telegram configuration and retained integration identity.'});}
let email:EmailTransport|undefined;
try{const config=emailConfig(dataRoot);if(config){email=new EmailTransport(store,config);email.start();}}catch{store.emit('email.unavailable',{detail:'Check private email configuration and retained integration identity.'});}
const maintain=setInterval(()=>{try{pruneInspections(dataRoot);store.vault.scan();if(store.company.expansion)void notifyOwnerRequests(store).catch(error=>{if(store.db.open)store.emit('maintenance.error',{error:redact(String(error))});});for(const name of ['daemon.log','service.log']){const path=join(dataRoot,'logs',name);if(existsSync(path)&&statSync(path).size>10_000_000){copyFileSync(path,`${path}.1`);truncateSync(path,0);}}}catch(error){store.emit('maintenance.error',{error:redact(String(error))});}},30_000);maintain.unref();
let ending=false;async function shutdown(){if(ending)return;ending=true;clearInterval(maintain);const deadline=setTimeout(()=>process.exit(1),7000);deadline.unref();try{await Promise.all([telegram?.stop(),email?.stop()]);await scheduler.shutdown();if('closeAllConnections' in server)server.closeAllConnections();if('closeAllConnections' in worker)worker.closeAllConnections();server.close();worker.close();freePool.state.close();store.close();if(existsSync(lockPath)&&JSON.parse(readFileSync(lockPath,'utf8')).pid===process.pid)unlinkSync(lockPath);}finally{clearTimeout(deadline);process.exit(0);}}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
process.on('unhandledRejection',error=>{process.stderr.write(`${redact(String(error))}\n`);void shutdown();});
