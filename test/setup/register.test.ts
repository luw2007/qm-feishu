import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeishuEventSource } from '../../src/ports.js';
import {
  discoverTenantKey,
  registerFeishuApplication,
  type RegisterApplicationFn,
} from '../../src/setup/register.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('registerFeishuApplication requests only qm-feishu scopes, event, callback, and minimal base', async () => {
  let captured: Parameters<RegisterApplicationFn>[0] | undefined;
  const registerApp: RegisterApplicationFn = async (options) => {
    captured = options;
    options.onQRCodeReady({ url: 'https://accounts.feishu.cn/device', expireIn: 600 });
    return {
      client_id: 'cli_test_setup_1',
      client_secret: 'secret_test_setup_1',
      user_info: { tenant_brand: 'feishu' },
    };
  };
  const lines: string[] = [];

  const result = await registerFeishuApplication({
    registerApp,
    appName: 'qm-feishu-test',
    writeLine: (line) => lines.push(line),
  });

  assert.deepEqual(result, {
    appId: 'cli_test_setup_1',
    appSecret: 'secret_test_setup_1',
    brand: 'feishu',
  });
  assert.ok(captured !== undefined);
  assert.deepEqual(captured.addons, {
    preset: false,
    scopes: {
      tenant: [
        'im:message',
        'im:message.p2p_msg:readonly',
        'im:message.group_at_msg:readonly',
        'im:message:send_as_bot',
        'im:resource',
        'im:chat:readonly',
      ],
    },
    events: { items: { tenant: ['im.message.receive_v1'] } },
    callbacks: { items: ['card.action.trigger'] },
  });
  assert.equal(captured.createOnly, true);
  assert.equal(captured.appPreset?.name, 'qm-feishu-test');
  assert.ok(lines.some((line) => line.includes('https://accounts.feishu.cn/device')));
  assert.equal(lines.some((line) => line.includes('secret_test_setup_1')), false);
});

test('registerFeishuApplication starts the requested Lark accounts flow', async () => {
  let captured: Parameters<RegisterApplicationFn>[0] | undefined;
  await registerFeishuApplication({
    brand: 'lark',
    registerApp: async (options) => {
      captured = options;
      return {
        client_id: 'cli_test_lark_1',
        client_secret: 'secret_test_lark_1',
        user_info: { tenant_brand: 'lark' },
      };
    },
    writeLine: () => undefined,
  });
  assert.ok(captured !== undefined);
  assert.equal(captured.domain, 'accounts.larksuite.com');
});

test('registerFeishuApplication maps an international tenant to lark', async () => {
  const result = await registerFeishuApplication({
    registerApp: async () => ({
      client_id: 'cli_test_lark_1',
      client_secret: 'secret_test_lark_1',
      user_info: { tenant_brand: 'lark' },
    }),
    writeLine: () => undefined,
  });
  assert.equal(result.brand, 'lark');
});

test('registerFeishuApplication reports stable errors without leaking SDK descriptions', async () => {
  await assert.rejects(
    registerFeishuApplication({
      registerApp: async () => {
        throw Object.assign(new Error('secret_test_setup_1'), { code: 'access_denied' });
      },
      writeLine: () => undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Feishu application registration failed: access_denied');
      assert.equal(error.message.includes('secret_test_setup_1'), false);
      return true;
    },
  );
});

test('discoverTenantKey waits for a verified message event and always closes the source', async () => {
  const started = deferred<void>();
  let stopped = 0;
  let handlers: Parameters<FeishuEventSource['start']>[0] | undefined;
  const source: FeishuEventSource = {
    start: async (registered) => {
      handlers = registered;
      started.resolve();
    },
    stop: async () => {
      stopped += 1;
    },
  };

  const pending = discoverTenantKey({ source, timeoutMs: 1_000 });
  await started.promise;
  assert.ok(handlers);
  await handlers.onMessage({ event_id: 'evt_missing_tenant' });
  await handlers.onMessage({ tenant_key: 'tenant_test_setup_1' });

  assert.equal(await pending, 'tenant_test_setup_1');
  assert.equal(stopped, 1);
});

test('discoverTenantKey times out and closes the source', async () => {
  let stopped = 0;
  const source: FeishuEventSource = {
    start: async () => undefined,
    stop: async () => {
      stopped += 1;
    },
  };

  await assert.rejects(discoverTenantKey({ source, timeoutMs: 5 }), /Timed out waiting for a Feishu message event/);
  assert.equal(stopped, 1);
});

test('discoverTenantKey times out even when the event source start promise never settles', async () => {
  let stopped = 0;
  const source: FeishuEventSource = {
    start: () => new Promise<void>(() => undefined),
    stop: async () => {
      stopped += 1;
    },
  };

  await assert.rejects(discoverTenantKey({ source, timeoutMs: 5 }), /Timed out waiting for a Feishu message event/);
  assert.equal(stopped, 1);
});
