import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeishuEventSource } from '../../src/ports.js';
import type { SetupArgs } from '../../src/setup/args.js';
import type { FeishuBotInfo, FeishuSetupCredentials } from '../../src/setup/feishu-api.js';
import { runSetup, SetupError, type SetupDependencies } from '../../src/setup/setup.js';

function dependencies(overrides: Partial<SetupDependencies> = {}): SetupDependencies {
  return {
    env: {},
    cwd: '/workspace/qm-feishu',
    writeLine: () => undefined,
    registerApplication: async () => ({
      appId: 'cli_registered_1',
      appSecret: 'secret_registered_1',
      brand: 'feishu',
    }),
    createApi: () => ({
      exchangeTenantAccessToken: async () => ({
        tenantAccessToken: 't-test-token',
        expiresInSeconds: 7_200,
      }),
      configureApplication: async () => undefined,
      probeBotInfo: async (): Promise<FeishuBotInfo> => ({
        openId: 'ou_test_bot_1',
        tenantKey: 'tenant_test_1',
      }),
    }),
    createEventSource: () => ({
      start: async () => undefined,
      stop: async () => undefined,
    }),
    persist: async () => undefined,
    ...overrides,
  };
}

const suppliedArgs: SetupArgs = {
  help: false,
  openPlatformAuto: true,
  appId: 'cli_supplied_1',
  appSecret: 'secret_supplied_1',
  coreApiUrl: 'http://127.0.0.1:18080/',
  coreSigningSecret: 'x'.repeat(32),
  envFile: 'config/runtime.env',
  brand: 'lark',
};

test('runSetup verifies supplied credentials and atomically persists the six runtime keys', async () => {
  let exchanged: FeishuSetupCredentials | undefined;
  let persisted: { path: string; updates: Record<string, string> } | undefined;
  const lines: string[] = [];

  const result = await runSetup(
    suppliedArgs,
    dependencies({
      writeLine: (line) => lines.push(line),
      createApi: (brand) => {
        assert.equal(brand, 'lark');
        return {
          exchangeTenantAccessToken: async (credentials) => {
            exchanged = credentials;
            return { tenantAccessToken: 't-test-token', expiresInSeconds: 7_200 };
          },
          configureApplication: async (appId, tenantAccessToken) => {
            assert.equal(appId, 'cli_supplied_1');
            assert.equal(tenantAccessToken, 't-test-token');
          },
          probeBotInfo: async () => ({ openId: 'ou_test_bot_2', tenantKey: 'tenant_test_2' }),
        };
      },
      persist: async (path, updates) => {
        persisted = { path, updates };
      },
    }),
  );

  assert.deepEqual(exchanged, { appId: 'cli_supplied_1', appSecret: 'secret_supplied_1' });
  assert.deepEqual(persisted, {
    path: '/workspace/qm-feishu/config/runtime.env',
    updates: {
      CORE_API_URL: 'http://127.0.0.1:18080',
      CORE_SIGNING_SECRET: 'x'.repeat(32),
      FEISHU_APP_ID: 'cli_supplied_1',
      FEISHU_APP_SECRET: 'secret_supplied_1',
      FEISHU_BOT_OPEN_ID: 'ou_test_bot_2',
      FEISHU_TENANT_KEY: 'tenant_test_2',
    },
  });
  assert.deepEqual(result, { envFile: '/workspace/qm-feishu/config/runtime.env', brand: 'lark' });
  assert.ok(lines.some((line) => line.includes('config/runtime.env')));
  assert.equal(lines.some((line) => line.includes('secret_supplied_1') || line.includes('t-test-token')), false);
});

test('runSetup registers an application and discovers a missing tenant key from a verified event', async () => {
  let sourceOptions: { appId: string; appSecret: string; brand: 'feishu' | 'lark' } | undefined;
  let handlers: Parameters<FeishuEventSource['start']>[0] | undefined;
  let persistedTenant: string | undefined;

  await runSetup(
    {
      help: false,
      openPlatformAuto: true,
      coreApiUrl: 'https://qm.test',
      coreSigningSecret: 'y'.repeat(32),
    },
    dependencies({
      createApi: () => ({
        exchangeTenantAccessToken: async () => ({ tenantAccessToken: 't-test-token', expiresInSeconds: 7_200 }),
        configureApplication: async () => undefined,
        probeBotInfo: async () => ({ openId: 'ou_registered_bot' }),
      }),
      createEventSource: (options) => {
        sourceOptions = options;
        return {
          start: async (registered) => {
            handlers = registered;
            queueMicrotask(() => {
              void handlers!.onMessage({ tenant_key: 'tenant_discovered_1' });
            });
          },
          stop: async () => undefined,
        };
      },
      persist: async (_path, updates) => {
        persistedTenant = updates.FEISHU_TENANT_KEY;
      },
    }),
  );

  assert.deepEqual(sourceOptions, {
    appId: 'cli_registered_1',
    appSecret: 'secret_registered_1',
    brand: 'feishu',
  });
  assert.equal(persistedTenant, 'tenant_discovered_1');
});

test('runSetup verifies an explicit tenant against a real event when Bot Info omits tenant_key', async () => {
  let persisted = false;
  await assert.rejects(
    runSetup(
      { ...suppliedArgs, tenantKey: 'tenant_stale_1' },
      dependencies({
        createApi: () => ({
          exchangeTenantAccessToken: async () => ({ tenantAccessToken: 't-test-token', expiresInSeconds: 7_200 }),
          configureApplication: async () => undefined,
          probeBotInfo: async () => ({ openId: 'ou_test_bot_1' }),
        }),
        createEventSource: () => ({
          start: async (handlers) => {
            await handlers.onMessage({ tenant_key: 'tenant_verified_1' });
          },
          stop: async () => undefined,
        }),
        persist: async () => {
          persisted = true;
        },
      }),
    ),
    (error: unknown) => error instanceof SetupError && error.code === 'tenant_mismatch',
  );
  assert.equal(persisted, false);
});

test('runSetup fails closed when an explicit tenant conflicts with verified bot info', async () => {
  let persisted = false;
  await assert.rejects(
    runSetup(
      { ...suppliedArgs, tenantKey: 'tenant_wrong' },
      dependencies({ persist: async () => { persisted = true; } }),
    ),
    (error: unknown) => error instanceof SetupError && error.code === 'tenant_mismatch',
  );
  assert.equal(persisted, false);
});

test('runSetup requires supplied credentials when Open Platform automation is disabled', async () => {
  await assert.rejects(
    runSetup(
      {
        help: false,
        openPlatformAuto: false,
        coreApiUrl: 'https://qm.test',
        coreSigningSecret: 'z'.repeat(32),
      },
      dependencies(),
    ),
    (error: unknown) => error instanceof SetupError && error.code === 'credentials_required',
  );
});


test('runSetup skips Open Platform mutation when automation is explicitly disabled', async () => {
  let configured = false;
  await runSetup(
    { ...suppliedArgs, openPlatformAuto: false },
    dependencies({
      createApi: () => ({
        exchangeTenantAccessToken: async () => ({ tenantAccessToken: 't-test-token', expiresInSeconds: 7_200 }),
        configureApplication: async () => {
          configured = true;
        },
        probeBotInfo: async () => ({ openId: 'ou_test_bot_1', tenantKey: 'tenant_test_1' }),
      }),
    }),
  );
  assert.equal(configured, false);
});
test('runSetup requires valid QM runtime values before contacting Feishu', async () => {
  let contacted = false;
  await assert.rejects(
    runSetup(
      { ...suppliedArgs, coreSigningSecret: 'short' },
      dependencies({
        createApi: () => {
          contacted = true;
          throw new Error('must not contact Feishu');
        },
      }),
    ),
    (error: unknown) => error instanceof SetupError && error.code === 'invalid_core_config',
  );
  assert.equal(contacted, false);
});
