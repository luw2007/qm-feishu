import assert from 'node:assert/strict';
import test from 'node:test';

import { startFeishuSurface } from '../src/index.ts';

void test('invalid runtime configuration rejects through the promise contract', async () => {
  const start = startFeishuSurface({
    coreApiUrl: '',
    coreSigningSecret: '',
    feishuAppId: '',
    feishuAppSecret: '',
  });

  await assert.rejects(start, /CORE_API_URL is required/);
});
