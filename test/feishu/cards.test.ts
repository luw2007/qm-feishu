import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { decodeCardAction, FeishuCardDecodeError } from '../../src/feishu/cards.js';

async function fixture(name: string): Promise<unknown> {
  const raw = await readFile(new URL(`../fixtures/feishu/${name}`, import.meta.url), 'utf8');
  return JSON.parse(raw);
}

test('decodeCardAction: schema-2.0 envelope', async () => {
  const action = decodeCardAction(await fixture('card-action.json'));
  assert.deepEqual(action, {
    eventId: 'evt_test_card_1',
    tenantKey: 'tenant_test_1',
    appId: 'cli_test_1',
    operatorOpenId: 'ou_test_operator_1',
    operatorTenantKey: 'tenant_test_1',
    requestId: 'req_test_1',
    action: 'allow_once',
  });
});

test('decodeCardAction: accepts a flattened event body', () => {
  const action = decodeCardAction({
    event_id: 'evt_test_card_2',
    tenant_key: 'tenant_test_2',
    app_id: 'cli_test_2',
    operator: { open_id: 'ou_test_operator_2', tenant_key: 'tenant_test_2' },
    action: { tag: 'button', value: { requestId: 'req_test_2', action: 'deny' } },
  });
  assert.deepEqual(action, {
    eventId: 'evt_test_card_2',
    tenantKey: 'tenant_test_2',
    appId: 'cli_test_2',
    operatorOpenId: 'ou_test_operator_2',
    operatorTenantKey: 'tenant_test_2',
    requestId: 'req_test_2',
    action: 'deny',
  });
});

test('decodeCardAction: rejects non-object input', () => {
  assert.throws(() => decodeCardAction(null), FeishuCardDecodeError);
});

test('decodeCardAction: rejects missing event_id', () => {
  assert.throws(
    () =>
      decodeCardAction({
        event: {
          operator: { open_id: 'ou_test_operator_1' },
          action: { value: { requestId: 'req_1', action: 'allow_once' } },
        },
      }),
    FeishuCardDecodeError,
  );
});

test('decodeCardAction: rejects when operator open_id is missing (never trusts action.value for identity)', () => {
  assert.throws(
    () =>
      decodeCardAction({
        header: { event_id: 'evt_1' },
        event: {
          action: { value: { requestId: 'req_1', action: 'allow_once', open_id: 'ou_test_forged_1' } },
        },
      }),
    FeishuCardDecodeError,
  );
});

test('decodeCardAction: rejects missing tenant and application attribution', () => {
  for (const raw of [
    {
      header: { event_id: 'evt_1', app_id: 'cli_test_1' },
      event: { operator: { open_id: 'ou_test_1', tenant_key: 'tenant_test_1' }, action: { value: { requestId: 'req_1', action: 'deny' } } },
    },
    {
      header: { event_id: 'evt_1', tenant_key: 'tenant_test_1' },
      event: { operator: { open_id: 'ou_test_1', tenant_key: 'tenant_test_1' }, action: { value: { requestId: 'req_1', action: 'deny' } } },
    },
    {
      header: { event_id: 'evt_1', tenant_key: 'tenant_test_1', app_id: 'cli_test_1' },
      event: { operator: { open_id: 'ou_test_1' }, action: { value: { requestId: 'req_1', action: 'deny' } } },
    },
  ]) {
    assert.throws(() => decodeCardAction(raw), FeishuCardDecodeError);
  }
});

test('decodeCardAction: rejects missing requestId', () => {
  assert.throws(
    () =>
      decodeCardAction({
        header: { event_id: 'evt_1' },
        event: {
          operator: { open_id: 'ou_test_operator_1' },
          action: { value: { action: 'allow_once' } },
        },
      }),
    FeishuCardDecodeError,
  );
});

test('decodeCardAction: rejects an action outside the known set', () => {
  assert.throws(
    () =>
      decodeCardAction({
        header: { event_id: 'evt_1' },
        event: {
          operator: { open_id: 'ou_test_operator_1' },
          action: { value: { requestId: 'req_1', action: 'delete_everything' } },
        },
      }),
    FeishuCardDecodeError,
  );
});
