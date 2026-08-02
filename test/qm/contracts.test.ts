import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QmContractError,
  decodeApproval,
  decodeBlobRef,
  decodeDeliveries,
  decodeQueuedRun,
  decodeRunView,
} from '../../src/qm/contracts.js';

test('contract decoders map current QM responses into the public port types', () => {
  assert.deepEqual(decodeQueuedRun({ status: 'queued', runId: 'run_test_1', steered: true }), {
    runId: 'run_test_1',
    queued: true,
    steered: true,
  });
  assert.deepEqual(
    decodeRunView('run_test_1', { status: 'done', result: { status: 'ok' }, startedAt: 1, finishedAt: 2 }),
    { runId: 'run_test_1', status: 'completed' },
  );
  assert.deepEqual(decodeBlobRef({ blobId: 'blob_test_1', sizeBytes: 4 }), {
    blobId: 'blob_test_1',
    sizeBytes: 4,
  });
});

test('delivery decoder rejects leakage while mapping QM destinations and attachments', () => {
  assert.deepEqual(
    decodeDeliveries({
      deliveries: [
        {
          id: 'delivery_test_1',
          destination: { type: 'feishu', target: 'chat:oc_test_1:message:om_test_1' },
          text: 'done',
          idempotencyKey: 'delivery-key-1',
          shadow: false,
          attachments: [
            { blobId: 'blob_test_1', name: 'in.txt', mimetype: 'text/plain', sizeBytes: 3 },
            {
              blobId: 'blob_test_2',
              artifactId: 'artifact_test_1',
              artifactViewerId: 'ou_test_1',
              name: 'out.txt',
              mimetype: 'text/plain',
              sizeBytes: 4,
            },
          ],
        },
      ],
    }),
    [
      {
        id: 'delivery_test_1',
        idempotencyKey: 'delivery-key-1',
        type: 'feishu',
        target: 'chat:oc_test_1:message:om_test_1',
        text: 'done',
        shadow: false,
        attachments: [
          { kind: 'blob', id: 'blob_test_1', filename: 'in.txt', mediaType: 'text/plain', sizeBytes: 3 },
          {
            kind: 'file',
            id: 'artifact_test_1',
            filename: 'out.txt',
            mediaType: 'text/plain',
            sizeBytes: 4,
            viewerId: 'ou_test_1',
          },
        ],
      },
    ],
  );
});

test('approval decoder exposes only the actor identity required by the port', () => {
  assert.deepEqual(
    decodeApproval({
      requestId: 'approval_test_1',
      command: 'deploy',
      grantModes: { session: true, always: false },
      request: { actor: { externalId: 'ou_test_1', displayName: 'Test User' }, text: 'secret body' },
    }),
    {
      requestId: 'approval_test_1',
      status: 'pending',
      command: 'deploy',
      grantModes: { once: true, session: true, always: false },
      request: { actor: { externalId: 'ou_test_1', displayName: 'Test User' } },
    },
  );
});

test('malformed successful contract bodies fail loudly', () => {
  for (const decode of [
    () => decodeQueuedRun({ status: 'queued' }),
    () => decodeRunView('run_test_1', { status: 'mystery' }),
    () => decodeBlobRef({ blobId: '', sizeBytes: -1 }),
    () => decodeDeliveries({ deliveries: [{ id: 'delivery_test_1' }] }),
    () => decodeApproval({ requestId: 42 }),
  ]) {
    assert.throws(decode, QmContractError);
  }
});
