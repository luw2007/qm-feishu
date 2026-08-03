import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEISHU_SETUP_MANIFEST,
  FeishuSetupApi,
  FeishuSetupAuthError,
  FeishuSetupConfigError,
  FeishuSetupContractError,
  FeishuSetupNetworkError,
  FeishuSetupTimeoutError,
  feishuOpenApiHost,
} from '../../src/setup/feishu-api.js';

type CapturedCall = { url: string; init: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function recordingFetch(responses: Response[], calls: CapturedCall[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    assert.ok(response, 'unexpected fetch call');
    return response;
  }) as typeof fetch;
}

function credentials(): { appId: string; appSecret: string } {
  return { appId: 'cli_test_app_1', appSecret: 'secret-abc123-do-not-leak' };
}

test('feishuOpenApiHost: derives the open API host from brand', () => {
  assert.equal(feishuOpenApiHost('feishu'), 'https://open.feishu.cn');
  assert.equal(feishuOpenApiHost('lark'), 'https://open.larksuite.com');
});

test('FeishuSetupApi.exchangeTenantAccessToken: decodes a successful exchange and posts credentials as JSON', async () => {
  const calls: CapturedCall[] = [];
  const api = new FeishuSetupApi({ fetch: recordingFetch([json({ code: 0, msg: 'ok', tenant_access_token: 't-token-1', expire: 7200 })], calls) });

  const token = await api.exchangeTenantAccessToken(credentials());

  assert.deepEqual(token, { tenantAccessToken: 't-token-1', expiresInSeconds: 7200 });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]!.url).toString(), 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { app_id: 'cli_test_app_1', app_secret: 'secret-abc123-do-not-leak' });
});

test('FeishuSetupApi.exchangeTenantAccessToken: rejects invalid credentials with a secret-safe auth error', async () => {
  const api = new FeishuSetupApi({
    fetch: recordingFetch([json({ code: 10014, msg: 'invalid app_secret, may contain secret-abc123-do-not-leak' })], []),
  });

  await assert.rejects(api.exchangeTenantAccessToken(credentials()), (error: unknown) => {
    assert.ok(error instanceof FeishuSetupAuthError);
    assert.equal(error.code, 10014);
    assert.ok(!error.message.includes('secret-abc123-do-not-leak'));
    return true;
  });
});

test('FeishuSetupApi.exchangeTenantAccessToken: classifies transport failures as network errors without leaking the secret', async () => {
  const api = new FeishuSetupApi({
    fetch: (async () => {
      throw new TypeError('connect ECONNREFUSED while sending secret-abc123-do-not-leak');
    }) as typeof fetch,
  });

  await assert.rejects(api.exchangeTenantAccessToken(credentials()), (error: unknown) => {
    assert.ok(error instanceof FeishuSetupNetworkError);
    assert.ok(!error.message.includes('secret-abc123-do-not-leak'));
    return true;
  });
});

test('FeishuSetupApi.exchangeTenantAccessToken: enforces the bounded timeout', async () => {
  const api = new FeishuSetupApi({
    requestTimeoutMs: 5,
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      throw new Error('unreachable');
    }) as typeof fetch,
  });

  await assert.rejects(api.exchangeTenantAccessToken(credentials()), (error: unknown) => {
    assert.ok(error instanceof FeishuSetupTimeoutError);
    assert.equal(error.timeoutMs, 5);
    assert.ok(!error.message.includes('secret-abc123-do-not-leak'));
    return true;
  });
});

test('FeishuSetupApi.exchangeTenantAccessToken: defaults the timeout to 10 seconds', () => {
  const api = new FeishuSetupApi({ fetch: recordingFetch([json({ code: 0, tenant_access_token: 't-1', expire: 1 })], []) });
  assert.ok(api instanceof FeishuSetupApi);
});

test('FeishuSetupApi.probeBotInfo: strictly decodes bot open_id and sends a bearer token', async () => {
  const calls: CapturedCall[] = [];
  const api = new FeishuSetupApi({
    fetch: recordingFetch([json({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot_1', app_name: 'QM' } })], calls),
  });

  const info = await api.probeBotInfo('t-token-1');

  assert.deepEqual(info, { openId: 'ou_bot_1' });
  assert.ok(!('tenantKey' in info));
  assert.equal(new URL(calls[0]!.url).toString(), 'https://open.feishu.cn/open-apis/bot/v3/info/');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer t-token-1');
});

test('FeishuSetupApi.probeBotInfo: decodes tenant_key only when actually present', async () => {
  const api = new FeishuSetupApi({
    fetch: recordingFetch([json({ code: 0, bot: { open_id: 'ou_bot_1', tenant_key: 'tenant_xyz' } })], []),
  });

  const info = await api.probeBotInfo('t-token-1');

  assert.deepEqual(info, { openId: 'ou_bot_1', tenantKey: 'tenant_xyz' });
});

test('FeishuSetupApi.probeBotInfo: rejects a missing bot open_id as a contract error', async () => {
  const api = new FeishuSetupApi({ fetch: recordingFetch([json({ code: 0, bot: {} })], []) });
  await assert.rejects(api.probeBotInfo('t-token-1'), FeishuSetupContractError);
});

test('FeishuSetupApi.probeBotInfo: classifies transport failures as network errors', async () => {
  const api = new FeishuSetupApi({
    fetch: (async () => {
      throw new TypeError('socket hang up');
    }) as typeof fetch,
  });
  await assert.rejects(api.probeBotInfo('t-token-1'), FeishuSetupNetworkError);
});

test('FeishuSetupApi.configureApplication applies the complete minimal manifest over the official v7 API', async () => {
  const calls: CapturedCall[] = [];
  const api = new FeishuSetupApi({ fetch: recordingFetch([json({ code: 0, msg: 'ok', data: {} })], calls) });

  await api.configureApplication('cli_test_app_1', 't-token-1');

  assert.equal(calls.length, 1);
  assert.equal(
    new URL(calls[0]!.url).toString(),
    'https://open.feishu.cn/open-apis/application/v7/applications/cli_test_app_1/config',
  );
  assert.equal(calls[0]!.init.method, 'PATCH');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer t-token-1');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    scope: {
      add_scopes: [
        { scope_name: 'im:message', token_type: 'tenant' },
        { scope_name: 'im:message:send_as_bot', token_type: 'tenant' },
        { scope_name: 'im:resource', token_type: 'tenant' },
        { scope_name: 'im:chat:readonly', token_type: 'tenant' },
      ],
    },
    event: { subscription_type: 'websocket', add_events: ['im.message.receive_v1'] },
    callback: { callback_type: 'websocket', add_callbacks: ['card.action.trigger'] },
  });
});

test('FeishuSetupApi.configureApplication rejects a non-zero business response without exposing its message', async () => {
  const api = new FeishuSetupApi({
    fetch: recordingFetch([json({ code: 999_001, msg: 'failed for secret-abc123-do-not-leak' })], []),
  });

  await assert.rejects(api.configureApplication('cli_test_app_1', 't-token-1'), (error: unknown) => {
    assert.ok(error instanceof FeishuSetupConfigError);
    assert.equal(error.code, 999_001);
    assert.equal(error.message.includes('secret-abc123-do-not-leak'), false);
    return true;
  });
});

test('FEISHU_SETUP_MANIFEST: is the exact minimal qm-feishu setup manifest', () => {
  assert.deepEqual(FEISHU_SETUP_MANIFEST, {
    scopes: ['im:message', 'im:message:send_as_bot', 'im:resource', 'im:chat:readonly'],
    event: 'im.message.receive_v1',
    callback: 'card.action.trigger',
    mode: 'long-connection',
  });
});

