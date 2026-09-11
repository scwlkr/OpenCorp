import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { inspectProcess, type ProcessReceipt } from './processes.js';

const exec = promisify(execFile);

/** HTTP proxy for local test services only. The native sandbox permits outbound
 * traffic solely to this proxy; every destination listener must belong to the
 * caller's kernel resource coalition. Owner/company/other employees are denied. */
export class OwnedLoopbackProxy {
  readonly secret = randomBytes(24).toString('hex');
  private server?: Server;
  private sockets = new Set<Socket>();
  private closed = false;
  receiptPath?: string;
  port = 0;
  constructor(private readonly forbiddenPorts: number[] = []) {}
  get url(): string { return `http://opencorp:${this.secret}@127.0.0.1:${this.port}`; }

  private async owned(port: number): Promise<boolean> {
    if (!this.receiptPath || this.closed || port < 1 || port > 65535 || port === this.port || this.forbiddenPorts.includes(port)) return false;
    try {
      const receipt = JSON.parse(await readFile(this.receiptPath, 'utf8')) as ProcessReceipt;
      if (receipt.state !== 'running' || !receipt.guardian) return false;
      const guardian = await inspectProcess(receipt.helper, receipt.guardian.pid);
      if ('status' in guardian || guardian.unique !== receipt.guardian.unique) return false;
      const { stdout } = await exec('/usr/sbin/lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp'], { timeout: 3000 });
      const pids = [...new Set([...stdout.matchAll(/^p(\d+)$/gm)].map(match => Number(match[1])))];
      if (!pids.length) return false;
      for (const pid of pids) {
        const identity = await inspectProcess(receipt.helper, pid);
        if ('status' in identity || identity.coalition !== guardian.coalition || identity.bootSeconds !== guardian.bootSeconds || identity.bootMicros !== guardian.bootMicros) return false;
      }
      return true;
    } catch { return false; }
  }

  async start(): Promise<void> {
    const auth = 'Basic ' + Buffer.from(`opencorp:${this.secret}`).toString('base64');
    this.server = createServer((request, response) => {
      void (async () => {
        if (request.headers['proxy-authorization'] !== auth) { response.writeHead(407, { 'proxy-authenticate': 'Basic realm="OpenCorp owned tests"' }); response.end(); return; }
        const url = new URL(request.url ?? '');
        const port = Number(url.port || '80');
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || !await this.owned(port)) { response.writeHead(403); response.end('Destination is not an owned test listener'); return; }
        const socket = connect({ host: '127.0.0.1', port });
        this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket));
        socket.on('error', () => response.destroy());
        await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
        if (!await this.owned(port)) { socket.destroy(); response.writeHead(403); response.end(); return; }
        const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: url.host, connection: 'close' };
        delete headers['proxy-authorization']; delete headers['proxy-connection'];
        const upstream = httpRequest({ host: '127.0.0.1', port, path: url.pathname + url.search, method: request.method, headers, createConnection: () => socket }, output => {
          response.writeHead(output.statusCode ?? 502, output.headers); output.pipe(response);
        });
        upstream.on('error', () => response.destroy()); request.pipe(upstream);
      })().catch(() => { if (!response.headersSent) { response.writeHead(403); response.end(); } else response.destroy(); });
    });
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => this.sockets.delete(socket)); });
    this.server.on('connect', (request, socket, head) => {
      const deny = () => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      void (async () => {
        if (request.headers['proxy-authorization'] !== auth) return deny();
        const match = /^(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(request.url ?? '');
        if (!match || !await this.owned(Number(match[1]))) return deny();
        const upstream = connect({ host: '127.0.0.1', port: Number(match[1]) });
        this.sockets.add(upstream); upstream.once('close', () => this.sockets.delete(upstream));
        upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy());
        upstream.once('connect', () => {
          void (async () => {
            // Recheck after connecting, before forwarding a single client byte,
            // to close the listener-exit/rebind gap in the initial check.
            if (!await this.owned(Number(match[1]))) { upstream.destroy(); return deny(); }
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            socket.pipe(upstream); upstream.pipe(socket);
          })().catch(() => { upstream.destroy(); deny(); });
        });
      })().catch(deny);
    });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('No owned test proxy port'); this.port = address.port;
  }
  async close(): Promise<void> {
    this.closed = true; for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => { if (this.server) this.server.close(() => resolve()); else resolve(); });
  }
}
