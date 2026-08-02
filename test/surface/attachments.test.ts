import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeishuPort, QmPort } from '../../src/ports.js';
import { derivePartUuid, FeishuDeliveryDispatcher } from '../../src/surface/deliveries.js';
import { handleIncomingMessage } from '../../src/surface/intake.js';
import type {
  Delivery,
  DeliveryAttachment,
  IncomingResource,
  MessageReceipt,
  NormalizedFeishuMessage,
  OutgoingFile,
  OutgoingMessage,
  QueuedRun,
  SurfaceTurn,
} from '../../src/types.js';

const BOT_OPEN_ID = 'ou_test_bot_1';
const TENANT_KEY = 'tenant_test_1';

function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`unused: ${name}`);
  };
}

function baseMessage(overrides: Partial<NormalizedFeishuMessage> = {}): NormalizedFeishuMessage {
  return {
    eventId: 'evt_test_1',
    tenantKey: TENANT_KEY,
    messageId: 'om_test_1',
    chatId: 'oc_test_dm_1',
    chatType: 'p2p',
    messageType: 'text',
    senderOpenId: 'ou_test_sender_1',
    senderType: 'user',
    createTime: 1_700_000_000_000,
    text: '',
    mentions: [],
    ...overrides,
  };
}

function streamOf(bytes: Uint8Array, chunkSize: number = Math.max(bytes.byteLength, 1)): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

function failingStream(goodChunk: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(goodChunk);
        return;
      }
      controller.error(new Error('ECONNRESET mid-download'));
    },
  });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// --- inbound: intake.ts ----------------------------------------------------

type IntakeQmCalls = { submitTurn: SurfaceTurn[]; stageBlob: { bytes: Uint8Array; filename: string; mediaType: string; sha256: string }[] };

function fakeIntakeQm(): { port: QmPort; calls: IntakeQmCalls } {
  const calls: IntakeQmCalls = { submitTurn: [], stageBlob: [] };
  const port: QmPort = {
    probe: notImplemented('probe'),
    submitTurn: async (input) => {
      calls.submitTurn.push(input);
      const result: QueuedRun = { runId: 'run_test_1', queued: true };
      return result;
    },
    getRun: notImplemented('getRun'),
    activeRun: async () => undefined,
    signalRun: notImplemented('signalRun'),
    claimDeliveries: notImplemented('claimDeliveries'),
    ackDelivery: notImplemented('ackDelivery'),
    ackDeliveryByKey: notImplemented('ackDeliveryByKey'),
    pendingApproval: notImplemented('pendingApproval'),
    getApproval: notImplemented('getApproval'),
    stageBlob: async (file) => {
      calls.stageBlob.push(file);
      return { blobId: 'blob_test_1', sizeBytes: file.bytes.byteLength };
    },
    readBlob: notImplemented('readBlob'),
    readFileArtifact: notImplemented('readFileArtifact'),
    pushDirectory: notImplemented('pushDirectory'),
    ingestSurfaceEvents: async () => undefined,
  };
  return { port, calls };
}

type IntakeFeishuCalls = { download: IncomingResource[] };

function fakeIntakeFeishu(downloadImpl?: (resource: IncomingResource) => Promise<ReadableStream<Uint8Array>>): {
  port: FeishuPort;
  calls: IntakeFeishuCalls;
} {
  const calls: IntakeFeishuCalls = { download: [] };
  const port: FeishuPort = {
    probe: notImplemented('probe'),
    reply: async () => ({ messageId: 'om_test_ack_1' }) satisfies MessageReceipt,
    send: notImplemented('send'),
    update: notImplemented('update'),
    download: async (resource) => {
      calls.download.push(resource);
      if (!downloadImpl) throw new Error('unused: download');
      return downloadImpl(resource);
    },
    upload: notImplemented('upload'),
  };
  return { port, calls };
}

test('handleIncomingMessage: an image message stages a bounded blob and preserves filename/media metadata', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const qm = fakeIntakeQm();
  const feishu = fakeIntakeFeishu(async () => streamOf(bytes, 2));
  const message = baseMessage({
    messageType: 'image',
    resource: { key: 'img_key_1', filename: 'photo.png', mediaType: 'image/png' },
  });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.equal(outcome.kind, 'accepted');
  assert.deepEqual(feishu.calls.download, [{ messageId: 'om_test_1', resourceKey: 'img_key_1', kind: 'image' }]);
  assert.equal(qm.calls.stageBlob.length, 1);
  const staged = qm.calls.stageBlob[0]!;
  assert.deepEqual(Array.from(staged.bytes), Array.from(bytes));
  assert.equal(staged.filename, 'photo.png');
  assert.equal(staged.mediaType, 'image/png');
  assert.equal(staged.sha256, sha256Hex(bytes));
  assert.deepEqual(qm.calls.submitTurn[0]!.attachments, [
    { blobId: 'blob_test_1', filename: 'photo.png', mediaType: 'image/png', sizeBytes: bytes.byteLength },
  ]);
});

test('handleIncomingMessage: a generic file message stages a bounded blob and preserves filename/media metadata', async () => {
  const bytes = new Uint8Array([9, 8, 7, 6, 5, 4]);
  const qm = fakeIntakeQm();
  const feishu = fakeIntakeFeishu(async () => streamOf(bytes, 3));
  const message = baseMessage({
    messageType: 'file',
    resource: { key: 'file_key_1', filename: 'report.pdf', mediaType: 'application/pdf' },
  });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.equal(outcome.kind, 'accepted');
  assert.deepEqual(feishu.calls.download, [{ messageId: 'om_test_1', resourceKey: 'file_key_1', kind: 'file' }]);
  const staged = qm.calls.stageBlob[0]!;
  assert.equal(staged.filename, 'report.pdf');
  assert.equal(staged.mediaType, 'application/pdf');
  assert.equal(staged.sha256, sha256Hex(bytes));
});

test('handleIncomingMessage: a 0-byte attachment is rejected before turn submission', async () => {
  const qm = fakeIntakeQm();
  const feishu = fakeIntakeFeishu(async () => streamOf(new Uint8Array(0)));
  const message = baseMessage({
    messageType: 'file',
    resource: { key: 'file_key_1', filename: 'empty.txt', mediaType: 'text/plain' },
  });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'rejected', reason: 'attachment_empty' });
  assert.equal(qm.calls.submitTurn.length, 0);
  assert.equal(qm.calls.stageBlob.length, 0);
});

test('handleIncomingMessage: an image over the 10MB ceiling is rejected before turn submission without full buffering', async () => {
  const qm = fakeIntakeQm();
  let chunksServed = 0;
  const oversizeStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunksServed += 1;
      controller.enqueue(new Uint8Array(4 * 1024 * 1024));
      if (chunksServed > 4) controller.close(); // safety valve for the test itself
    },
  });
  const feishu = fakeIntakeFeishu(async () => oversizeStream);
  const message = baseMessage({
    messageType: 'image',
    resource: { key: 'img_key_1', filename: 'huge.png', mediaType: 'image/png' },
  });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'rejected', reason: 'attachment_oversized' });
  assert.equal(qm.calls.submitTurn.length, 0);
  assert.equal(qm.calls.stageBlob.length, 0);
  assert.ok(chunksServed <= 4, 'reader must be cancelled once the bound is crossed, not drained to the safety valve');
});

test('handleIncomingMessage: a file over the 30MB ceiling is rejected before turn submission', async () => {
  const qm = fakeIntakeQm();
  let chunksServed = 0;
  const oversizeStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunksServed += 1;
      controller.enqueue(new Uint8Array(16 * 1024 * 1024));
      if (chunksServed > 4) controller.close();
    },
  });
  const feishu = fakeIntakeFeishu(async () => oversizeStream);
  const message = baseMessage({
    messageType: 'file',
    resource: { key: 'file_key_1', filename: 'huge.bin', mediaType: 'application/octet-stream' },
  });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'rejected', reason: 'attachment_oversized' });
  assert.equal(qm.calls.submitTurn.length, 0);
});

test('handleIncomingMessage: a stream failure mid-download is rejected before turn submission', async () => {
  const qm = fakeIntakeQm();
  const feishu = fakeIntakeFeishu(async () => failingStream(new Uint8Array([9, 9])));
  const message = baseMessage({
    messageType: 'file',
    resource: { key: 'file_key_1', filename: 'flaky.bin', mediaType: 'application/octet-stream' },
  });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'rejected', reason: 'attachment_unavailable' });
  assert.equal(qm.calls.submitTurn.length, 0);
  assert.equal(qm.calls.stageBlob.length, 0);
});

// --- outbound: deliveries.ts -------------------------------------------------

function fakeDeliveryQm(overrides: Partial<QmPort> = {}): QmPort {
  return {
    probe: async () => undefined,
    submitTurn: notImplemented('submitTurn'),
    getRun: notImplemented('getRun'),
    activeRun: async () => undefined,
    signalRun: async () => undefined,
    claimDeliveries: async () => [],
    ackDelivery: async () => undefined,
    ackDeliveryByKey: async () => undefined,
    pendingApproval: async () => null,
    getApproval: async () => null,
    stageBlob: notImplemented('stageBlob'),
    readBlob: notImplemented('readBlob'),
    readFileArtifact: notImplemented('readFileArtifact'),
    pushDirectory: async () => undefined,
    ingestSurfaceEvents: async () => undefined,
    ...overrides,
  };
}

function fakeDeliveryFeishu(overrides: Partial<FeishuPort> = {}): FeishuPort {
  return {
    probe: async () => undefined,
    reply: notImplemented('reply'),
    send: async () => ({ messageId: 'om_test_reply_1' }) satisfies MessageReceipt,
    update: async () => undefined,
    download: notImplemented('download'),
    upload: notImplemented('upload'),
    ...overrides,
  };
}

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: 'delivery_test_1',
    idempotencyKey: 'key_test_1',
    type: 'feishu',
    target: 'chat:oc_test_1:message:om_test_1',
    text: 'hello',
    ...overrides,
  };
}

function blobAttachment(overrides: Partial<DeliveryAttachment> = {}): DeliveryAttachment {
  return { kind: 'blob', id: 'blob_test_1', filename: 'photo.png', mediaType: 'image/png', ...overrides };
}

function fileAttachment(overrides: Partial<DeliveryAttachment> = {}): DeliveryAttachment {
  return { kind: 'file', id: 'artifact_test_1', filename: 'report.pdf', mediaType: 'application/pdf', viewerId: 'ou_viewer_1', ...overrides };
}

test('FeishuDeliveryDispatcher: text then attachments send in order, uploaded to Feishu before each idempotent message part', async () => {
  const sentMessages: OutgoingMessage[] = [];
  const uploaded: OutgoingFile[] = [];
  const acked: string[] = [];
  const imageBytes = new Uint8Array([1, 2, 3]);
  const fileBytes = new Uint8Array([4, 5, 6, 7]);
  const qm = fakeDeliveryQm({
    claimDeliveries: async () => [delivery({ text: 'hi', attachments: [blobAttachment(), fileAttachment()] })],
    readBlob: async (id) => {
      assert.equal(id, 'blob_test_1');
      return streamOf(imageBytes);
    },
    readFileArtifact: async (id, viewerId) => {
      assert.equal(id, 'artifact_test_1');
      assert.equal(viewerId, 'ou_viewer_1');
      return streamOf(fileBytes);
    },
    ackDelivery: async (id) => {
      acked.push(id);
    },
  });
  const feishu = fakeDeliveryFeishu({
    send: async (_target, message) => {
      sentMessages.push(message);
      return { messageId: `om_test_${String(sentMessages.length)}` };
    },
    upload: async (file) => {
      uploaded.push(file);
      return file.kind === 'image' ? { kind: 'image', key: 'img_key_uploaded_1' } : { kind: 'file', key: 'file_key_uploaded_1' };
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu });

  await dispatcher.poll();

  assert.deepEqual(sentMessages.map((message) => message.kind), ['text', 'image', 'file']);
  assert.equal(uploaded.length, 2);
  assert.equal(uploaded[0]!.mediaType, 'image/png');
  assert.equal(uploaded[1]!.mediaType, 'application/pdf');
  const imageMessage = sentMessages[1]!;
  const fileMessage = sentMessages[2]!;
  assert.equal(imageMessage.kind === 'image' ? imageMessage.imageKey : undefined, 'img_key_uploaded_1');
  assert.equal(fileMessage.kind === 'file' ? fileMessage.fileKey : undefined, 'file_key_uploaded_1');
  assert.equal(imageMessage.uuid, derivePartUuid('key_test_1', 0, 'attachment'));
  assert.equal(fileMessage.uuid, derivePartUuid('key_test_1', 1, 'attachment'));
  assert.deepEqual(acked, ['delivery_test_1']);
});

test('FeishuDeliveryDispatcher: a non-image attachment over the image ceiling but within the file ceiling still succeeds', async () => {
  const bytes = new Uint8Array(15 * 1024 * 1024);
  let uploadCalls = 0;
  const acked: string[] = [];
  const qm = fakeDeliveryQm({
    claimDeliveries: async () => [delivery({ text: 'hi', attachments: [fileAttachment({ mediaType: 'application/zip' })] })],
    readFileArtifact: async () => streamOf(bytes, 1024 * 1024),
    ackDelivery: async (id) => {
      acked.push(id);
    },
  });
  const feishu = fakeDeliveryFeishu({
    send: async () => ({ messageId: 'om_test_reply_1' }),
    upload: async (file) => {
      uploadCalls += 1;
      assert.equal(file.bytes.byteLength, bytes.byteLength);
      return { kind: 'file', key: 'file_key_uploaded_1' };
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu });

  await dispatcher.poll();

  assert.equal(uploadCalls, 1);
  assert.deepEqual(acked, ['delivery_test_1']);
});

test('FeishuDeliveryDispatcher: an oversized outbound attachment is a permanent terminal failure that acks once without uploading', async () => {
  const acked: string[] = [];
  let uploadCalls = 0;
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(11 * 1024 * 1024));
      controller.close();
    },
  });
  const qm = fakeDeliveryQm({
    claimDeliveries: async () => [delivery({ text: 'hi', attachments: [blobAttachment()] })],
    readBlob: async () => oversized,
    ackDelivery: async (id) => {
      acked.push(id);
    },
  });
  const feishu = fakeDeliveryFeishu({
    send: async () => ({ messageId: 'om_test_reply_1' }),
    upload: async (file) => {
      uploadCalls += 1;
      return { kind: file.kind, key: 'img_key_uploaded_1' };
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu });

  await dispatcher.poll();

  assert.deepEqual(acked, ['delivery_test_1']);
  assert.equal(uploadCalls, 0);
});

test('FeishuDeliveryDispatcher: an empty outbound attachment is a permanent terminal failure', async () => {
  const acked: string[] = [];
  const qm = fakeDeliveryQm({
    claimDeliveries: async () => [delivery({ text: 'hi', attachments: [blobAttachment()] })],
    readBlob: async () => streamOf(new Uint8Array(0)),
    ackDelivery: async (id) => {
      acked.push(id);
    },
  });
  const feishu = fakeDeliveryFeishu({ send: async () => ({ messageId: 'om_test_reply_1' }) });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu });

  await dispatcher.poll();

  assert.deepEqual(acked, ['delivery_test_1']);
});

test('FeishuDeliveryDispatcher: a transient attachment failure leaves an attachment-bearing delivery unacked, and retry resends text with the same UUID', async () => {
  const firstPassTexts: string[] = [];
  const secondPassTexts: string[] = [];
  let attempt = 0;
  let readAttempts = 0;
  const acked: string[] = [];
  const qm = fakeDeliveryQm({
    claimDeliveries: async () => [delivery({ text: 'hello', attachments: [blobAttachment()] })],
    readBlob: async () => {
      readAttempts += 1;
      if (readAttempts === 1) throw new Error('ECONNRESET');
      return streamOf(new Uint8Array([1, 2, 3]));
    },
    ackDelivery: async (id) => {
      acked.push(id);
    },
  });
  const feishu = fakeDeliveryFeishu({
    send: async (_target, message) => {
      if (message.kind === 'text') (attempt === 0 ? firstPassTexts : secondPassTexts).push(message.text);
      return { messageId: 'om_test_reply_1' };
    },
    upload: async () => ({ kind: 'image', key: 'img_key_uploaded_1' }),
  });

  const first = new FeishuDeliveryDispatcher({ qm, feishu });
  await first.poll();
  assert.deepEqual(acked, [], 'a transient attachment failure must not ack even though the text part already succeeded');

  attempt = 1;
  const retry = new FeishuDeliveryDispatcher({ qm, feishu });
  await retry.poll();

  assert.deepEqual(firstPassTexts, ['hello']);
  assert.deepEqual(secondPassTexts, ['hello']);
  assert.deepEqual(acked, ['delivery_test_1']);
});

test('FeishuDeliveryDispatcher: retrying a delivery with attachments reuses the same UUIDs and order for every part', async () => {
  const firstPass: string[] = [];
  const secondPass: string[] = [];
  let attempt = 0;
  const qm = fakeDeliveryQm({
    claimDeliveries: async () => [delivery({ text: 'hi', attachments: [blobAttachment(), fileAttachment()] })],
    readBlob: async () => streamOf(new Uint8Array([1, 2, 3])),
    readFileArtifact: async () => streamOf(new Uint8Array([4, 5, 6])),
  });
  const feishu = fakeDeliveryFeishu({
    send: async (_target, message) => {
      (attempt === 0 ? firstPass : secondPass).push(message.uuid);
      return { messageId: 'om_test_reply_1' };
    },
    upload: async (file) => (file.kind === 'image' ? { kind: 'image', key: 'img_key_uploaded_1' } : { kind: 'file', key: 'file_key_uploaded_1' }),
  });

  const first = new FeishuDeliveryDispatcher({ qm, feishu });
  await first.poll();

  attempt = 1;
  const retry = new FeishuDeliveryDispatcher({ qm, feishu });
  await retry.poll();

  assert.equal(firstPass.length, 3);
  assert.deepEqual(firstPass, secondPass);
});

test('FeishuDeliveryDispatcher: attachment-bearing delivery is never acked merely because text and an earlier attachment succeeded', async () => {
  const acked: string[] = [];
  let secondAttachmentAttempts = 0;
  const qm = fakeDeliveryQm({
    claimDeliveries: async () => [
      delivery({ text: 'hi', attachments: [blobAttachment({ id: 'blob_ok' }), fileAttachment({ id: 'artifact_bad' })] }),
    ],
    readBlob: async (id) => {
      assert.equal(id, 'blob_ok');
      return streamOf(new Uint8Array([1, 2, 3]));
    },
    readFileArtifact: async () => {
      secondAttachmentAttempts += 1;
      throw new Error('ECONNRESET');
    },
    ackDelivery: async (id) => {
      acked.push(id);
    },
  });
  const feishu = fakeDeliveryFeishu({
    send: async () => ({ messageId: 'om_test_reply_1' }),
    upload: async () => ({ kind: 'image', key: 'img_key_uploaded_1' }),
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu });

  await dispatcher.poll();

  assert.equal(secondAttachmentAttempts, 1);
  assert.deepEqual(acked, []);
});
