import { statfsSync, readFileSync, existsSync } from 'node:fs';
import { totalmem, freemem } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../storage/store.js';
import { LocalRuntime, opencodeBinary } from '../runtime/index.js';
import { CorporateBroker } from '../tools/broker.js';
import { runProcess } from '../tools/process.js';
import { sourceRoot, readDiscovery } from './paths.js';
import { serviceStatus } from './service.js';
export async function doctor(store:CompanyStore,runtime:LocalRuntime,broker:CorporateBroker){
 const checks=await Promise.all([['node',process.execPath,['--version']],['OpenCode',opencodeBinary,['--version']],['Ollama','/usr/local/bin/ollama',['--version']],['git','/usr/bin/git',['--version']],['GitHub','gh',['api','user','--jq','.login']],['macOS','/usr/bin/sw_vers',['-productVersion']],['compiler','/usr/bin/clang',['--version']]].map(async([name,file,args])=>{try{const r=await runProcess(file as string,args as string[],{timeoutMs:10_000,maxOutput:2000});return {name,status:r.code===0?'available':'unavailable',detail:r.stdout.trim()||r.stderr.trim()};}catch(e){return {name,status:'unavailable',detail:String(e)};}}));
 const gh=checks.find(c=>c.name==='GitHub');const integrations=[{id:'github',name:'GitHub',status:gh?.status==='available'?'connected':'unavailable',detail:gh?.status==='available'?`Connected identity ${gh.detail}; product-target and cost checks apply to every action.`:gh?.detail??'Unavailable'},await broker.connected.doctor(),{id:'browser',name:'Playwright MCP',status:existsSync(join(sourceRoot,'node_modules/@playwright/mcp/cli.js'))?'connected':'unavailable',detail:'Version 0.0.80; isolated product/research browser, controlled read-only endpoints. No personal profile.'},{id:'email',name:'Product email',status:'unavailable',detail:'No supported local product email adapter configured. Messages cannot be sent through builder-only connectors.'},{id:'release',name:'Release channels',status:'conditional',detail:'WalkLang: exact reviewed merge, local canonical release build, immutable SHA256 assets and reconciled GitHub publication. OpenJob native stores and paletteWOW deployment remain conditional on actual provider/candidate requirements and confirmed zero incremental charge.'}];
 for(const item of integrations)store.put('integrations',{...item,id:(item as any).id??'macos'});
 const disk=statfsSync(store.dataRoot),runtimeState=runtime.status();const pkg=JSON.parse(readFileSync(join(sourceRoot,'package.json'),'utf8'));
 return {application:'OpenCorp',version:pkg.version,checkedAt:new Date().toISOString(),company:store.company,policy:store.policy,host:{platform:process.platform,architecture:process.arch,totalMemory:totalmem(),freeMemory:freemem(),availableDiskBytes:disk.bavail*disk.bsize},tools:checks,models:store.list('models').map(m=>({...m,serviceRunning:runtimeState.ollama.running})),runtime:runtimeState,integrations,service:await serviceStatus(store.dataRoot),discovery:readDiscovery(store.dataRoot),prerequisites:store.list('attention').filter(a=>a.status==='open'),dataRoot:store.dataRoot};
}
