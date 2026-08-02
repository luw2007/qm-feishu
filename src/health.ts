import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export type HealthServer = {
  readonly host: string;
  readonly port: number;
  setReady(ready: boolean): void;
  stop(): Promise<void>;
};

export type HealthServerOptions = {
  host: string;
  port: number;
  metrics?: () => Record<string, number>;
};

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  let ready = false;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET') {
      send(res, 404, { status: 'not_found' });
      return;
    }
    if (req.url === '/healthz') {
      send(res, 200, { status: 'ok' });
      return;
    }
    if (req.url === '/readyz') {
      send(res, ready ? 200 : 503, { status: ready ? 'ok' : 'unavailable' });
      return;
    }
    if (req.url === '/metrics') {
      send(res, 200, options.metrics?.() ?? {});
      return;
    }
    send(res, 404, { status: 'not_found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      server.on('error', () => { ready = false; });
      const address = server.address();
      const boundPort = address !== null && typeof address === 'object' ? address.port : options.port;
      resolve({
        host: options.host,
        port: boundPort,
        setReady(value: boolean): void {
          ready = value;
        },
        stop(): Promise<void> {
          return new Promise((res, rej) => {
            server.close((error) => {
              if (error) rej(error);
              else res();
            });
          });
        },
      });
    });
  });
}
