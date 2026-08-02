import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { QmPort } from '../../src/ports.js';
import type { SurfaceTurn } from '../../src/types.js';
import {
  QmAuthError,
  QmContractError,
  QmNetworkError,
  QmPermanentError,
  QmTimeoutError,
  QmTransientError,
} from '../../src/qm/contracts.js';
import { QmHttpClient } from '../../src/qm/client.js';
import { signRequest } from '../../src/qm/source-auth.js';

type CapturedCall = { url: string; init: RequestInit };

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function turn(): SurfaceTurn {
  return {
    text: 'hello',
    actor: { externalId: 'ou_test_1', displayName: 'Test User' },
    conversation: { id: 'oc_test_1', kind: 'group', name: 'Test Group' },
    threadRef: 'feishu:chat:oc_test_1:message:om_test_1',
    destination: 'chat:oc_test_1:message:om_test_1',
    surface: 'feishu',
    addressed: true,
    surfaceTools: false,
    idempotencyKey: 'om_test_1',
    origin: { kind: 'human', messageTs: '1700000000000' },
    triggerTs: 1_700_000_000_000,
    displayText: 'Test User: hello',
  };
}

function recordingFetch(responses: Response[], calls: CapturedCall[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    assert.ok(response, 'unexpected fetch call');
    return response;
  }) as typeof fetch;
}

test('QmHttpClient structurally satisfies QmPort and constructs every JSON route explicitly', async () => {
  const calls: CapturedCall[] = [];
  const client: QmPort = new QmHttpClient({
    baseUrl: 'http://qm.test/',
    signingSecret: 'contract-secret',
    now: () => 1_700_000_000_000,
    fetch: recordingFetch(
      [
        json({ ok: true }),
        json({ status: 'queued', runId: 'run/test % 1' }, 202),
        json({ status: 'running', result: null, startedAt: 1, finishedAt: null }),
        json({ runId: 'run/test % 1' }),
        json({ accepted: true }),
        json({ deliveries: [] }),
        json({ ok: true }),
        json({ ok: true }),
        json({ pending: null }),
        json({ ok: true, members: 1, channels: 1 }),
        json({ ok: true, upserted: 1 }),
      ],
      calls,
    ),
  });

  await client.probe();
  await client.submitTurn(turn());
  await client.getRun('run/test % 1');
  await client.activeRun('feishu:dm:oc_test_1 / 100%');
  await client.signalRun('run/test % 1', { kind: 'steer', text: 'new direction' });
  await client.claimDeliveries('feishu & principal', 30_000);
  await client.ackDelivery('delivery/test % 1', { threadRef: 'feishu:dm:oc_test_1', messageIds: ['om_test_2'] });
  await client.ackDeliveryByKey('key / 100%');
  await client.pendingApproval('feishu:dm:oc_test_1');
  await client.pushDirectory({
    members: [{ principalId: 'ou_test_1', displayName: 'Test User', active: true }],
    channels: [{ id: 'oc_test_1', name: 'Test Group' }],
  });
  await client.ingestSurfaceEvents([
    {
      container: 'oc_test_1',
      ts: '1700000000000',
      threadTs: '1699999999999',
      actorId: 'ou_test_1',
      text: 'hello',
      files: [{ fileId: 'file_test_1', name: 'a.txt', mediaType: 'text/plain', sizeBytes: 1 }],
    },
  ]);

  assert.deepEqual(
    calls.map(({ url, init }) => [new URL(url).pathname + new URL(url).search, init.method]),
    [
      ['/healthz', 'GET'],
      ['/v1/turns?async=1', 'POST'],
      ['/v1/runs/run%2Ftest%20%25%201', 'GET'],
      ['/v1/runs?threadRef=feishu%3Adm%3Aoc_test_1+%2F+100%25', 'GET'],
      ['/v1/runs/run%2Ftest%20%25%201/signal', 'POST'],
      ['/v1/deliveries?type=feishu+%26+principal&claimMs=30000', 'GET'],
      ['/v1/deliveries/delivery%2Ftest%20%25%201/ack', 'POST'],
      ['/v1/deliveries/ack-by-key', 'POST'],
      ['/v1/approvals/pending?threadRef=feishu%3Adm%3Aoc_test_1', 'GET'],
      ['/v1/directory', 'POST'],
      ['/v1/surface-cache/ingest', 'POST'],
    ],
  );

  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), {
    text: 'hello',
    actor: { externalId: 'ou_test_1', displayName: 'Test User' },
    conversation: {
      kind: 'group',
      threadRef: 'feishu:chat:oc_test_1:message:om_test_1',
      channelRef: 'oc_test_1',
      channelName: 'Test Group',
    },
    deliveryTarget: 'chat:oc_test_1:message:om_test_1',
    surface: 'feishu',
    addressed: true,
    surfaceTools: false,
    idempotencyKey: 'om_test_1',
    origin: { kind: 'human', messageTs: '1700000000000' },
    triggerTs: '1700000000000',
    displayText: 'Test User: hello',
    async: true,
  });
  assert.deepEqual(JSON.parse(String(calls[6]!.init.body)), { recipientThreadRef: 'feishu:dm:oc_test_1' });
  assert.deepEqual(JSON.parse(String(calls[9]!.init.body)), {
    members: [{ principalId: 'ou_test_1', displayName: 'Test User', type: 'internal' }],
    channels: [{ channelId: 'oc_test_1', name: 'Test Group' }],
  });
  assert.deepEqual(JSON.parse(String(calls[10]!.init.body)), {
    surface: 'feishu',
    events: [
      {
        container: 'oc_test_1',
        ts: '1700000000000',
        sub: '1699999999999',
        authorId: 'ou_test_1',
        text: 'hello',
        files: [{ fileId: 'file_test_1', name: 'a.txt', mimetype: 'text/plain' }],
      },
    ],
  });
});

test('blob upload signs the hexadecimal digest while sending raw bytes', async () => {
  const calls: CapturedCall[] = [];
  const bytes = new TextEncoder().encode('blob');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const client = new QmHttpClient({
    baseUrl: 'http://qm.test',
    signingSecret: 'contract-secret',
    now: () => 1_700_000_000_000,
    fetch: recordingFetch([json({ blobId: 'blob_test_1', sizeBytes: 4 })], calls),
  });

  assert.deepEqual(await client.stageBlob({ bytes, filename: 'a.bin', mediaType: 'application/octet-stream', sha256: digest }), {
    blobId: 'blob_test_1',
    sizeBytes: 4,
  });
  assert.deepEqual(calls[0]!.init.body, bytes);
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get('x-content-sha256'), digest);
  assert.equal(
    headers.get('x-signature'),
    signRequest('contract-secret', 1_700_000_000, `POST\n/v1/blobs\n${digest}`),
  );
});

test('binary reads and approval lookup use encoded identifiers and runtime validation', async () => {
  const calls: CapturedCall[] = [];
  const client = new QmHttpClient({
    baseUrl: 'http://qm.test',
    signingSecret: 'contract-secret',
    fetch: recordingFetch(
      [
        new Response('blob-bytes'),
        new Response('file-bytes'),
        json({ pending: { status: 'pending_approval', pendingApprovals: [{ requestId: 'approval/test 1' }] } }),
        json({
          requestId: 'approval/test 1',
          command: 'deploy',
          grantModes: { session: false, always: false },
          request: { actor: { externalId: 'ou_test_1' } },
        }),
        json({ error: 'not_found' }, 404),
      ],
      calls,
    ),
  });

  assert.equal(await new Response(await client.readBlob('blob/test 1')).text(), 'blob-bytes');
  assert.equal(await new Response(await client.readFileArtifact('artifact/test 1', 'ou_test_1 / viewer')).text(), 'file-bytes');
  assert.equal((await client.pendingApproval('feishu:dm:oc_test_1'))?.request?.actor?.externalId, 'ou_test_1');
  assert.equal(await client.getApproval('missing/test'), null);
  assert.deepEqual(
    calls.map(({ url }) => new URL(url).pathname + new URL(url).search),
    [
      '/v1/blobs/blob%2Ftest%201',
      '/v1/files/artifact%2Ftest%201/content?viewer=ou_test_1+%2F+viewer',
      '/v1/approvals/pending?threadRef=feishu%3Adm%3Aoc_test_1',
      '/v1/approvals/approval%2Ftest%201',
      '/v1/approvals/missing%2Ftest',
    ],
  );
});

test('HTTP failures have typed, retry-aware, secret-safe errors', async () => {
  const scenarios = [
    [json({ error: 'unauthorized', message: 'secret leaked' }, 401), QmAuthError],
    [json({ error: 'bad_request', message: 'tenant payload' }, 400), QmPermanentError],
    [json({ error: 'rate_limited' }, 429, { 'retry-after': '2' }), QmTransientError],
    [json({ error: 'unavailable' }, 503), QmTransientError],
  ] as const;

  for (const [response, ErrorType] of scenarios) {
    const client = new QmHttpClient({
      baseUrl: 'http://qm.test',
      signingSecret: 'do-not-leak-this-secret',
      fetch: recordingFetch([response], []),
    });
    await assert.rejects(client.probe(), (error: unknown) => {
      assert.ok(error instanceof ErrorType);
      assert.doesNotMatch((error as Error).message, /secret leaked|tenant payload|do-not-leak/);
      if (error instanceof QmTransientError && error.status === 429) assert.equal(error.retryAfterMs, 2_000);
      return true;
    });
  }
});

test('malformed 2xx, network failures, and local timeouts are distinct', async () => {
  const malformed = new QmHttpClient({
    baseUrl: 'http://qm.test',
    signingSecret: 'contract-secret',
    fetch: recordingFetch([json({ status: 'queued' }, 202)], []),
  });
  await assert.rejects(malformed.submitTurn(turn()), QmContractError);

  const network = new QmHttpClient({
    baseUrl: 'http://qm.test',
    signingSecret: 'contract-secret',
    fetch: (async () => {
      throw new TypeError('connect ECONNREFUSED with tenant payload');
    }) as typeof fetch,
  });
  await assert.rejects(network.probe(), QmNetworkError);

  const timeout = new QmHttpClient({
    baseUrl: 'http://qm.test',
    signingSecret: 'contract-secret',
    requestTimeoutMs: 5,
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      throw new Error('unreachable');
    }) as typeof fetch,
  });
  await assert.rejects(timeout.probe(), QmTimeoutError);
});

test('rejects redirects and bounds successful JSON responses', async () => {
  const calls: CapturedCall[] = [];
  const client = new QmHttpClient({
    baseUrl: 'http://qm.test',
    signingSecret: 'contract-secret',
    maxJsonResponseBytes: 32,
    fetch: recordingFetch([
      new Response(JSON.stringify({ ok: true, padding: 'x'.repeat(64) }), {
        headers: { 'content-length': '100' },
      }),
    ], calls),
  });

  await assert.rejects(client.probe(), QmContractError);
  assert.equal(calls[0]!.init.redirect, 'error');
});

test('classifies successful response body stream failures as network errors', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('partial body failure with tenant payload'));
    },
  });
  const client = new QmHttpClient({
    baseUrl: 'http://qm.test',
    signingSecret: 'contract-secret',
    fetch: recordingFetch([new Response(body)], []),
  });

  await assert.rejects(client.probe(), QmNetworkError);
});
