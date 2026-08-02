import assert from 'node:assert/strict';
import test from 'node:test';

import { handleIncomingMessage } from '../../src/surface/intake.js';
import type { FeishuPort, QmPort } from '../../src/ports.js';
import type {
  MessageReceipt,
  NormalizedFeishuMessage,
  OutgoingMessage,
  QueuedRun,
  SurfaceEvent,
  SurfaceTurn,
} from '../../src/types.js';

const BOT_OPEN_ID = 'ou_test_bot_1';
const TENANT_KEY = 'tenant_test_1';

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
    text: 'hello there',
    mentions: [],
    ...overrides,
  };
}

function withoutTenantKey(message: NormalizedFeishuMessage): NormalizedFeishuMessage {
  const clone: NormalizedFeishuMessage = { ...message };
  delete clone.tenantKey;
  return clone;
}

function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`unused: ${name}`);
  };
}

type QmCalls = {
  submitTurn: SurfaceTurn[];
  activeRun: string[];
  signalRun: { runId: string; signal: { kind: 'abort' | 'steer'; text?: string } }[];
  ingestSurfaceEvents: SurfaceEvent[][];
};

function fakeQm(
  overrides: Partial<QmPort> & { activeRunResult?: string | undefined; refuse?: boolean; ingestFails?: boolean } = {},
): {
  port: QmPort;
  calls: QmCalls;
  order: string[];
} {
  const calls: QmCalls = { submitTurn: [], activeRun: [], signalRun: [], ingestSurfaceEvents: [] };
  const order: string[] = [];
  const port: QmPort = {
    probe: notImplemented('probe'),
    submitTurn: async (input) => {
      calls.submitTurn.push(input);
      order.push('submitTurn');
      if (overrides.refuse) {
        const error = new Error('refused') as Error & { status: number };
        error.status = 403;
        throw error;
      }
      const result: QueuedRun = { runId: 'run_test_1', queued: true };
      return result;
    },
    getRun: notImplemented('getRun'),
    activeRun: async (threadRef) => {
      calls.activeRun.push(threadRef);
      return overrides.activeRunResult;
    },
    signalRun: async (runId, signal) => {
      calls.signalRun.push({ runId, signal });
      order.push('signalRun');
    },
    claimDeliveries: notImplemented('claimDeliveries'),
    ackDelivery: notImplemented('ackDelivery'),
    ackDeliveryByKey: notImplemented('ackDeliveryByKey'),
    pendingApproval: notImplemented('pendingApproval'),
    getApproval: notImplemented('getApproval'),
    stageBlob: notImplemented('stageBlob'),
    readBlob: notImplemented('readBlob'),
    readFileArtifact: notImplemented('readFileArtifact'),
    pushDirectory: notImplemented('pushDirectory'),
    ingestSurfaceEvents: async (events) => {
      calls.ingestSurfaceEvents.push(events);
      order.push('ingestSurfaceEvents');
      if (overrides.ingestFails) throw new Error('surface-cache unavailable');
    },
    ...overrides,
  };
  return { port, calls, order };
}

type FeishuCalls = { reply: { messageId: string; message: OutgoingMessage }[] };

function fakeFeishu(order: string[]): { port: FeishuPort; calls: FeishuCalls } {
  const calls: FeishuCalls = { reply: [] };
  const port: FeishuPort = {
    probe: notImplemented('probe'),
    reply: async (messageId, message) => {
      calls.reply.push({ messageId, message });
      order.push('reply');
      const receipt: MessageReceipt = { messageId: 'om_test_ack_1' };
      return receipt;
    },
    send: notImplemented('send'),
    update: notImplemented('update'),
    download: notImplemented('download'),
    upload: notImplemented('upload'),
  };
  return { port, calls };
}

test('handleIncomingMessage: direct messages are always accepted and map open_id to actor externalId', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage();

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'accepted', runId: 'run_test_1', threadRef: 'feishu:dm:oc_test_dm_1', steered: false });
  assert.equal(qm.calls.submitTurn.length, 1);
  const turn = qm.calls.submitTurn[0]!;
  assert.equal(turn.actor.externalId, 'ou_test_sender_1');
  assert.equal(turn.threadRef, 'feishu:dm:oc_test_dm_1');
  assert.equal(turn.destination, 'chat:oc_test_dm_1:message:om_test_1');
  assert.equal(turn.surface, 'feishu');
  assert.equal(turn.addressed, true);
  assert.equal(turn.surfaceTools, false);
  assert.equal(turn.idempotencyKey, 'feishu:message:om_test_1');
});

test('handleIncomingMessage: group messages that explicitly mention the bot exactly once are accepted', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage({
    chatType: 'group',
    chatId: 'oc_test_group_1',
    messageId: 'om_test_trigger_1',
    mentions: [BOT_OPEN_ID],
    text: '@bot please review',
  });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.equal(outcome.kind, 'accepted');
  assert.equal(qm.calls.submitTurn.length, 1);
  assert.equal(qm.calls.submitTurn[0]!.threadRef, 'feishu:chat:oc_test_group_1:message:om_test_trigger_1');
});

test('handleIncomingMessage: unmentioned group messages produce no turn', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage({ chatType: 'group', chatId: 'oc_test_group_1', mentions: [] });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'ignored', reason: 'unmentioned' });
  assert.equal(qm.calls.submitTurn.length, 0);
});

test('handleIncomingMessage: a group message mentioning the bot more than once fails closed as ambiguous', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage({ chatType: 'group', chatId: 'oc_test_group_1', mentions: [BOT_OPEN_ID, BOT_OPEN_ID] });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'rejected', reason: 'ambiguous_mention' });
  assert.equal(qm.calls.submitTurn.length, 0);
});

test('handleIncomingMessage: the application\'s own messages produce no turn', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage({ senderOpenId: BOT_OPEN_ID });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'ignored', reason: 'self' });
  assert.equal(qm.calls.submitTurn.length, 0);
});

test('handleIncomingMessage: an external tenant fails closed', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage({ tenantKey: 'tenant_test_other' });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'rejected', reason: 'external_tenant' });
  assert.equal(qm.calls.submitTurn.length, 0);
});

test('handleIncomingMessage: a missing tenant key fails closed as external tenant', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);
  const message = withoutTenantKey(baseMessage());

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'rejected', reason: 'external_tenant' });
  assert.equal(qm.calls.submitTurn.length, 0);
});

test('handleIncomingMessage: a missing sender identity fails closed', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage({ senderOpenId: '  ' });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'rejected', reason: 'missing_identity' });
  assert.equal(qm.calls.submitTurn.length, 0);
});

test('handleIncomingMessage: post content is a supported turn', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage({ messageType: 'post', text: 'release notes\nshipped' });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.equal(outcome.kind, 'accepted');
  assert.equal(qm.calls.submitTurn[0]!.text, 'release notes\nshipped');
});

test('handleIncomingMessage: image and file messages produce no turn (attachments are out of scope)', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);

  for (const messageType of ['image', 'file'] as const) {
    const message = baseMessage({ messageType, text: '' });
    const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
      botOpenId: BOT_OPEN_ID,
      tenantKey: TENANT_KEY,
    });
    assert.deepEqual(outcome, { kind: 'ignored', reason: 'unsupported_message_type' });
  }
  assert.equal(qm.calls.submitTurn.length, 0);
});

test('handleIncomingMessage: duplicate message_id values reuse the same idempotency key', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage({ messageId: 'om_test_dup_1' });

  await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, { botOpenId: BOT_OPEN_ID, tenantKey: TENANT_KEY });
  await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, { botOpenId: BOT_OPEN_ID, tenantKey: TENANT_KEY });

  assert.equal(qm.calls.submitTurn.length, 2);
  assert.equal(qm.calls.submitTurn[0]!.idempotencyKey, 'feishu:message:om_test_dup_1');
  assert.equal(qm.calls.submitTurn[1]!.idempotencyKey, 'feishu:message:om_test_dup_1');
});

test('handleIncomingMessage: an explicit stop input signals the active run instead of enqueueing a second run', async () => {
  const qm = fakeQm({ activeRunResult: 'run_active_1' });
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage({ text: 'stop' });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'signaled', runId: 'run_active_1', threadRef: 'feishu:dm:oc_test_dm_1' });
  assert.equal(qm.calls.submitTurn.length, 0);
  assert.equal(qm.calls.signalRun.length, 1);
  assert.deepEqual(qm.calls.signalRun[0], { runId: 'run_active_1', signal: { kind: 'abort' } });
});

test('handleIncomingMessage: stop text with no active run submits an ordinary turn', async () => {
  const qm = fakeQm({ activeRunResult: undefined });
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage({ text: 'stop' });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.equal(outcome.kind, 'accepted');
  assert.equal(qm.calls.submitTurn.length, 1);
  assert.equal(qm.calls.signalRun.length, 0);
});

test('handleIncomingMessage: an ordinary follow-up while a run is active submits normally and returns steered', async () => {
  const qm = fakeQm({ activeRunResult: 'run_active_1' });
  qm.port.submitTurn = async (input) => {
    qm.calls.submitTurn.push(input);
    const result: QueuedRun = { runId: 'run_active_1', queued: true, steered: true };
    return result;
  };
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage({ text: 'one more thing' });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'accepted', runId: 'run_active_1', threadRef: 'feishu:dm:oc_test_dm_1', steered: true });
  assert.equal(qm.calls.signalRun.length, 0);
});

test('handleIncomingMessage: acknowledgement is posted only after QM accepts the turn', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage();

  await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, { botOpenId: BOT_OPEN_ID, tenantKey: TENANT_KEY });

  assert.deepEqual(qm.order.slice(0, 2), ['submitTurn', 'reply']);
  assert.equal(feishu.calls.reply.length, 1);
  assert.equal(feishu.calls.reply[0]!.messageId, 'om_test_1');
});

test('handleIncomingMessage: a QM 403 is a terminal refusal, not a retried infrastructure failure', async () => {
  const qm = fakeQm({ refuse: true });
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage();

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, { kind: 'refused', threadRef: 'feishu:dm:oc_test_dm_1' });
  assert.equal(feishu.calls.reply.length, 0);
});

test('handleIncomingMessage: surface-cache failure does not roll back the accepted turn or resubmit it', async () => {
  const qm = fakeQm({ ingestFails: true });
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage();

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.equal(outcome.kind, 'accepted');
  assert.equal(qm.calls.submitTurn.length, 1);
  assert.equal(qm.calls.ingestSurfaceEvents.length, 1);
});

test('handleIncomingMessage: returns the queued runId and threadRef for the approval watcher', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage({ chatType: 'group', chatId: 'oc_test_group_2', mentions: [BOT_OPEN_ID], messageId: 'om_test_g1', rootId: 'om_test_root_g1' });

  const outcome = await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.deepEqual(outcome, {
    kind: 'accepted',
    runId: 'run_test_1',
    threadRef: 'feishu:chat:oc_test_group_2:message:om_test_root_g1',
    steered: false,
  });
});

test('handleIncomingMessage: topic delivery target uses the resolved root message', async () => {
  const qm = fakeQm();
  const feishu = fakeFeishu(qm.order);
  const message = baseMessage({
    chatType: 'group',
    chatId: 'oc_test_group_2',
    mentions: [BOT_OPEN_ID],
    messageId: 'om_test_followup_1',
    rootId: 'om_test_root_1',
  });

  await handleIncomingMessage(message, { qm: qm.port, feishu: feishu.port }, {
    botOpenId: BOT_OPEN_ID,
    tenantKey: TENANT_KEY,
  });

  assert.equal(qm.calls.submitTurn[0]?.destination, 'chat:oc_test_group_2:message:om_test_root_1');
});
