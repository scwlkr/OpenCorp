import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { OwnedOllama } from '../src/runtime/ollama.js';

afterEach(() => vi.restoreAllMocks());
describe('owned inventory cancellation', () => {
  it('invalidates queued inventory before it can restart a stopped pool', async () => {
    const ollama = new OwnedOllama({ dataRoot: '/unused-inventory-fixture' }, 'micro');
    let entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const read = vi.spyOn(ollama as any, 'readModels').mockImplementationOnce((_context: unknown, suppliedSignal: unknown) => new Promise((_resolve, reject) => {
      const signal = suppliedSignal as AbortSignal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }); entered();
    })).mockResolvedValue([]);
    const first = ollama.models(), queued = ollama.models();
    const settled = Promise.allSettled([first, queued]); await began;
    await ollama.stop();
    expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(read).toHaveBeenCalledTimes(1);
    // A new explicit request after completed stop owns a fresh generation.
    await expect(ollama.models()).resolves.toEqual([]); expect(read).toHaveBeenCalledTimes(2);
  });
  it('aborts an in-flight HTTP inventory and drains it before stop returns', async () => {
    let entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const server = createServer(() => entered());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const ollama = new OwnedOllama({ dataRoot: '/unused-inventory-fixture' });
    vi.spyOn(ollama, 'start').mockResolvedValue(); ollama.url = `http://127.0.0.1:${address.port}`;
    try {
      const pending = ollama.models(); const settled = Promise.allSettled([pending]); await began;
      await ollama.stop(); expect((await settled)[0].status).toBe('rejected'); expect(ollama.url).toBe('');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
