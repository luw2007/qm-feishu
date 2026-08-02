import { configFromEnv } from './config.js';
import { startFeishuSurface } from './runtime.js';
import type { FeishuSurfaceHandle } from './runtime.js';

function reportFatal(event: string, error: unknown): void {
  const errorClass = error instanceof Error ? error.name : 'UnknownError';
  process.stderr.write(`${JSON.stringify({ level: 'error', event, errorClass })}\n`);
}

async function main(): Promise<void> {
  const handle: FeishuSurfaceHandle = await startFeishuSurface(configFromEnv());

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    handle
      .stop()
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        reportFatal('shutdown_failed', error);
        process.exit(1);
      });
  }

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  reportFatal('startup_failed', error);
  process.exit(1);
});
