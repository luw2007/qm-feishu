import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { QmHttpClient } from '../../src/qm/client.js';

const QM_REVISION = '7f2c916';
const baseUrl = process.env.QM_CONTRACT_BASE_URL;
const signingSecret = process.env.QM_CONTRACT_SIGNING_SECRET;
const skipReason = baseUrl ? false : 'QM_CONTRACT_BASE_URL is unset; start the pinned local QM checkout to run this contract';

test(`QM source-auth contract at revision ${QM_REVISION}`, { skip: skipReason }, async (t) => {
  assert.ok(baseUrl);
  assert.ok(signingSecret, 'QM_CONTRACT_SIGNING_SECRET is required when QM_CONTRACT_BASE_URL is set');
  assert.ok(signingSecret.length >= 32, 'QM_CONTRACT_SIGNING_SECRET must contain at least 32 characters');

  const client = new QmHttpClient({ baseUrl, signingSecret });

  await t.test('health and authenticated blob round trip', async () => {
    await client.probe();
    const bytes = new TextEncoder().encode('qm-feishu-contract');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const staged = await client.stageBlob({
      bytes,
      filename: 'contract.txt',
      mediaType: 'text/plain',
      sha256,
    });
    assert.equal(await new Response(await client.readBlob(staged.blobId)).text(), 'qm-feishu-contract');
  });

  await t.test('async Feishu turn preserves the external protocol fields', async () => {
    const queued = await client.submitTurn({
      text: 'qm-feishu contract turn',
      actor: { externalId: 'ou_test_contract' },
      conversation: { id: 'oc_test_contract', kind: 'dm' },
      threadRef: 'feishu:dm:oc_test_contract',
      destination: 'user:ou_test_contract',
      surface: 'feishu',
      addressed: true,
      surfaceTools: false,
      idempotencyKey: `qm-feishu-${Date.now()}`,
      origin: { kind: 'human', messageTs: String(Date.now()) },
      triggerTs: Date.now(),
      displayText: 'contract turn',
    });
    assert.ok(queued.runId);
    assert.equal((await client.getRun(queued.runId)).runId, queued.runId);
  });

  await t.test('delivery claim route is source authenticated', async () => {
    assert.ok(Array.isArray(await client.claimDeliveries('feishu', 1_000)));
  });
});
