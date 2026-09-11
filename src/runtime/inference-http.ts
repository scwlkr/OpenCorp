import { request, type IncomingMessage } from 'node:http';

// A local decoder can buffer an entire tool argument before sending any SSE
// content. Node's fetch adds 300s header/body idle timers; this transport is
// governed by the existing run AbortSignal instead of an unrelated deadline.
export function requestLocalInference(url: string, body: string, signal: AbortSignal): Promise<IncomingMessage> {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port
    || target.pathname !== '/v1/chat/completions' || target.username || target.password || target.search || target.hash) {
    throw new Error('Inference transport requires the owned loopback completion endpoint');
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const pending = request(target, { method: 'POST', signal, agent: false, timeout: 0,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, resolve);
    // Keep this listener after headers: aborting the request also destroys its
    // streamed response, whose iterator then reports the interruption.
    pending.on('error', reject);
    pending.end(body);
  });
}
