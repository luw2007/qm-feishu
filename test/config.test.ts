import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeishuSurfaceConfig } from '../src/config.ts';
import { configFromEnv, resolveConfig } from '../src/config.ts';
import { startFeishuSurface } from '../src/index.ts';

function validConfig(overrides: Partial<FeishuSurfaceConfig> = {}): FeishuSurfaceConfig {
  return {
    coreApiUrl: 'http://127.0.0.1:18080',
    coreSigningSecret: 'x'.repeat(32),
    feishuAppId: 'cli_test_app',
    feishuAppSecret: 'secret_test',
    feishuBotOpenId: 'ou_test_bot_1',
    feishuTenantKey: 'tenant_test_1',
    ...overrides,
  };
}

void test('invalid runtime configuration rejects through the promise contract', async () => {
  const start = startFeishuSurface({
    coreApiUrl: '',
    coreSigningSecret: '',
    feishuAppId: '',
    feishuAppSecret: '',
    feishuBotOpenId: '',
    feishuTenantKey: '',
  });
  await assert.rejects(start, /CORE_API_URL is required/);
});

void test('resolveConfig requires every mandatory field', () => {
  const fields: Array<keyof FeishuSurfaceConfig> = [
    'coreApiUrl',
    'coreSigningSecret',
    'feishuAppId',
    'feishuAppSecret',
    'feishuBotOpenId',
    'feishuTenantKey',
  ];
  for (const field of fields) {
    assert.throws(() => resolveConfig(validConfig({ [field]: '' })), /is required/, `expected ${field} to be required`);
  }
});

void test('resolveConfig rejects a short signing secret', () => {
  assert.throws(() => resolveConfig(validConfig({ coreSigningSecret: 'too-short' })), /at least 32 characters/);
});

void test('resolveConfig rejects a non-HTTP core API URL', () => {
  assert.throws(() => resolveConfig(validConfig({ coreApiUrl: 'ftp://example.com' })), /HTTP or HTTPS/);
});

void test('resolveConfig reports a stable error for a malformed core API URL', () => {
  assert.throws(() => resolveConfig(validConfig({ coreApiUrl: 'not a url' })), /CORE_API_URL must be a valid HTTP or HTTPS URL/);
});

void test('resolveConfig applies documented defaults for optional fields', () => {
  const resolved = resolveConfig(validConfig());
  assert.equal(resolved.claimPrincipalDeliveries, false);
  assert.equal(resolved.deliveryClaimMs, 30_000);
  assert.equal(resolved.deliveryPollMs, 1_000);
  assert.equal(resolved.approvalPollMs, 1_000);
  assert.equal(resolved.requestTimeoutMs, 10_000);
  assert.equal(resolved.shutdownTimeoutMs, 15_000);
  assert.equal(resolved.healthHost, '127.0.0.1');
  assert.equal(resolved.healthPort, 3000);
  assert.equal(resolved.logLevel, 'info');
});

void test('resolveConfig rejects non-positive numeric fields', () => {
  for (const field of ['deliveryClaimMs', 'deliveryPollMs', 'approvalPollMs', 'requestTimeoutMs', 'shutdownTimeoutMs'] as const) {
    assert.throws(() => resolveConfig(validConfig({ [field]: 0 })), /must be a positive integer/, `expected ${field} to reject 0`);
    assert.throws(() => resolveConfig(validConfig({ [field]: -1 })), /must be a positive integer/, `expected ${field} to reject -1`);
  }
});

void test('resolveConfig allows healthPort 0 for ephemeral binding but rejects out-of-range ports', () => {
  assert.equal(resolveConfig(validConfig({ healthPort: 0 })).healthPort, 0);
  assert.throws(() => resolveConfig(validConfig({ healthPort: -1 })), /between 0 and 65535/);
  assert.throws(() => resolveConfig(validConfig({ healthPort: 70_000 })), /between 0 and 65535/);
});

void test('resolveConfig rejects an invalid logLevel', () => {
  assert.throws(
    () => resolveConfig(validConfig({ logLevel: 'verbose' as 'debug' | 'info' | 'warn' | 'error' })),
    /LOG_LEVEL must be one of/,
  );
});

void test('configFromEnv reads every documented environment variable', () => {
  const config = configFromEnv({
    CORE_API_URL: 'http://127.0.0.1:18080',
    CORE_SIGNING_SECRET: 'x'.repeat(32),
    FEISHU_APP_ID: 'cli_test_app',
    FEISHU_APP_SECRET: 'secret_test',
    FEISHU_BOT_OPEN_ID: 'ou_test_bot_1',
    FEISHU_TENANT_KEY: 'tenant_test_1',
    FEISHU_CLAIM_PRINCIPAL_DELIVERIES: '1',
    FEISHU_DELIVERY_CLAIM_MS: '45000',
    FEISHU_DELIVERY_POLL_MS: '2000',
    FEISHU_APPROVAL_POLL_MS: '3000',
    CORE_REQUEST_TIMEOUT_MS: '5000',
    FEISHU_SHUTDOWN_TIMEOUT_MS: '20000',
    HEALTH_HOST: '0.0.0.0',
    HEALTH_PORT: '0',
    LOG_LEVEL: 'debug',
  } as unknown as NodeJS.ProcessEnv);

  assert.deepEqual(resolveConfig(config), {
    coreApiUrl: 'http://127.0.0.1:18080',
    coreSigningSecret: 'x'.repeat(32),
    feishuAppId: 'cli_test_app',
    feishuAppSecret: 'secret_test',
    feishuBotOpenId: 'ou_test_bot_1',
    feishuTenantKey: 'tenant_test_1',
    claimPrincipalDeliveries: true,
    deliveryClaimMs: 45_000,
    deliveryPollMs: 2_000,
    approvalPollMs: 3_000,
    requestTimeoutMs: 5_000,
    shutdownTimeoutMs: 20_000,
    healthHost: '0.0.0.0',
    healthPort: 0,
    logLevel: 'debug',
  });
});

void test('configFromEnv falls back to documented defaults when optional variables are unset', () => {
  const config = configFromEnv({
    CORE_API_URL: 'http://127.0.0.1:18080',
    CORE_SIGNING_SECRET: 'x'.repeat(32),
    FEISHU_APP_ID: 'cli_test_app',
    FEISHU_APP_SECRET: 'secret_test',
    FEISHU_BOT_OPEN_ID: 'ou_test_bot_1',
    FEISHU_TENANT_KEY: 'tenant_test_1',
  } as unknown as NodeJS.ProcessEnv);

  const resolved = resolveConfig(config);
  assert.equal(resolved.claimPrincipalDeliveries, false);
  assert.equal(resolved.deliveryClaimMs, 30_000);
  assert.equal(resolved.healthHost, '127.0.0.1');
  assert.equal(resolved.healthPort, 3000);
  assert.equal(resolved.logLevel, 'info');
});
