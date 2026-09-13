import { afterEach, expect, test, vi } from 'vitest';
import { LocalRuntime } from '../src/runtime/index.js';
import { OwnedOllama } from '../src/runtime/ollama.js';
import type { LocalModel } from '../src/runtime/types.js';

afterEach(()=>vi.restoreAllMocks());
test('stop during primary inventory never starts the micro pool after shutdown',async()=>{
 let entered!:()=>void,release!:()=>void;const atInventory=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});const inventoryPools:string[]=[];
 vi.spyOn(OwnedOllama.prototype,'start').mockResolvedValue();vi.spyOn(OwnedOllama.prototype,'stop').mockResolvedValue();
 vi.spyOn(OwnedOllama.prototype,'models').mockImplementation(async function(this:OwnedOllama):Promise<LocalModel[]>{inventoryPools.push(this.root);if(!this.root.endsWith('ollama-micro')){entered();await held;}return [];});
 const runtime=new LocalRuntime({dataRoot:'/unused/runtime-stop-inventory-fixture'}),inventory=runtime.models();await atInventory;
 await runtime.stop();release();await Promise.allSettled([inventory]);
 expect(inventoryPools.some(path=>path.endsWith('ollama-micro'))).toBe(false);expect(runtime.status().started).toBe(false);
});
