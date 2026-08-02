import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeishuPort, QmPort } from '../../src/ports.js';
import type { Delivery, DeliveryReceipt, FeishuTarget, OutgoingMessage } from '../../src/types.js';
import {
  derivePartUuid,
  FeishuDeliveryDispatcher,
  parseDeliveryTarget,
  splitDeliveryText,
} from '../../src/surface/deliveries.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeQm(overrides: Partial<QmPort> = {}): QmPort {
  return {
    probe: async () => undefined,
    submitTurn: async () => {
      throw new Error('not implemented');
    },
    getRun: async () => {
      throw new Error('not implemented');
    },
    activeRun: async () => undefined,
    signalRun: async () => undefined,
    claimDeliveries: async () => [],
    ackDelivery: async () => undefined,
    ackDeliveryByKey: async () => undefined,
    pendingApproval: async () => null,
    getApproval: async () => null,
    stageBlob: async () => {
      throw new Error('not implemented');
    },
    readBlob: async () => {
      throw new Error('not implemented');
    },
    readFileArtifact: async () => {
      throw new Error('not implemented');
    },
    pushDirectory: async () => undefined,
    ingestSurfaceEvents: async () => undefined,
    ...overrides,
  };
}

function fakeFeishu(overrides: Partial<FeishuPort> = {}): FeishuPort {
  return {
    probe: async () => undefined,
    reply: async () => {
      throw new Error('not implemented');
    },
    send: async () => ({ messageId: 'om_test_reply_1' }),
    update: async () => undefined,
    download: async () => {
      throw new Error('not implemented');
    },
    upload: async () => {
      throw new Error('not implemented');
    },
    ...overrides,
  };
}

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: 'delivery_test_1',
    idempotencyKey: 'key_test_1',
    type: 'feishu',
    target: 'chat:oc_test_1:message:om_test_1',
    text: 'hello world',
    ...overrides,
  };
}

// --- pure helpers -----------------------------------------------------

test('parseDeliveryTarget accepts the chat and user grammar', () => {
  assert.deepEqual(parseDeliveryTarget('chat:oc_test_1:message:om_test_1'), {
    kind: 'reply',
    chatId: 'oc_test_1',
    messageId: 'om_test_1',
  });
  assert.deepEqual(parseDeliveryTarget('user:ou_test_1'), { kind: 'user', openId: 'ou_test_1' });
});

test('parseDeliveryTarget rejects unknown prefixes, empty identifiers, and extra segments', () => {
  const malformed = [
    'unknown:oc_test_1',
    'chat:oc_test_1',
    'chat::message:om_test_1',
    'chat:oc_test_1:message:',
    'chat:oc_test_1:message:om_test_1:extra',
    'user:',
    'user:ou_test_1:extra',
    '',
  ];
  for (const target of malformed) {
    assert.equal(parseDeliveryTarget(target), undefined, `expected ${target} to be rejected`);
  }
});

test('splitDeliveryText produces deterministic, stable-boundary chunks', () => {
  assert.deepEqual(splitDeliveryText('hello world', 5), ['hello', ' worl', 'd']);
  assert.deepEqual(splitDeliveryText('abcdef', 3), ['abc', 'def']);
  assert.deepEqual(splitDeliveryText('', 5), ['']);
  assert.deepEqual(splitDeliveryText('hello world', 5), splitDeliveryText('hello world', 5));
});

test('derivePartUuid is stable, at most 50 characters, and varies with its inputs', () => {
  const uuid = derivePartUuid('key_test_1', 0, 'text');
  assert.equal(uuid, derivePartUuid('key_test_1', 0, 'text'));
  assert.ok(uuid.length <= 50);
  assert.notEqual(uuid, derivePartUuid('key_test_1', 1, 'text'));
  assert.notEqual(uuid, derivePartUuid('key_test_2', 0, 'text'));
  assert.notEqual(uuid, derivePartUuid('key_test_1', 0, 'attachment'));
});

// --- claim gating -------------------------------------------------------

test('poll always claims feishu deliveries and skips principal deliveries by default', async () => {
  const claimedTypes: string[] = [];
  const qm = fakeQm({
    claimDeliveries: async (type) => {
      claimedTypes.push(type);
      return [];
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu: fakeFeishu() });

  await dispatcher.poll();

  assert.deepEqual(claimedTypes, ['feishu']);
});

test('poll claims principal deliveries only when FEISHU_CLAIM_PRINCIPAL_DELIVERIES is explicitly enabled', async () => {
  const claimedTypes: string[] = [];
  const qm = fakeQm({
    claimDeliveries: async (type) => {
      claimedTypes.push(type);
      return [];
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu: fakeFeishu(), claimPrincipalDeliveries: true });

  await dispatcher.poll();

  assert.deepEqual(claimedTypes, ['feishu', 'principal']);
});

// --- terminal disposition ------------------------------------------------

test('malformed targets are acknowledged without any Feishu call', async () => {
  const acked: string[] = [];
  let sendCalls = 0;
  const qm = fakeQm({
    claimDeliveries: async () => [delivery({ target: 'unknown:oc_test_1' })],
    ackDelivery: async (id) => {
      acked.push(id);
    },
  });
  const feishu = fakeFeishu({
    send: async () => {
      sendCalls += 1;
      throw new Error('must not be called');
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu });

  await dispatcher.poll();

  assert.deepEqual(acked, ['delivery_test_1']);
  assert.equal(sendCalls, 0);
});

test('shadow deliveries are acknowledged without any Feishu call', async () => {
  const acked: string[] = [];
  let sendCalls = 0;
  const qm = fakeQm({
    claimDeliveries: async () => [delivery({ shadow: true })],
    ackDelivery: async (id) => {
      acked.push(id);
    },
  });
  const feishu = fakeFeishu({
    send: async () => {
      sendCalls += 1;
      throw new Error('must not be called');
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu });

  await dispatcher.poll();

  assert.deepEqual(acked, ['delivery_test_1']);
  assert.equal(sendCalls, 0);
});

// --- reply / proactive delivery -------------------------------------------

test('reply-chain deliveries reply in place and principal deliveries send proactively', async () => {
  const sentTargets: FeishuTarget[] = [];
  const qm = fakeQm({
    claimDeliveries: async (type) =>
      type === 'feishu'
        ? [delivery({ id: 'delivery_test_1', target: 'chat:oc_test_1:message:om_test_1' })]
        : [delivery({ id: 'delivery_test_2', type: 'principal', idempotencyKey: 'key_test_2', target: 'user:ou_test_1' })],
  });
  const feishu = fakeFeishu({
    send: async (target: FeishuTarget) => {
      sentTargets.push(target);
      return { messageId: 'om_test_reply_1', chatId: 'oc_test_dm_1' };
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu, claimPrincipalDeliveries: true });

  await dispatcher.poll();

  assert.deepEqual(sentTargets, [
    { kind: 'reply', chatId: 'oc_test_1', messageId: 'om_test_1' },
    { kind: 'user', openId: 'ou_test_1' },
  ]);
});

test('successful principal delivery records the resolved DM threadRef on acknowledgement', async () => {
  const receipts: (DeliveryReceipt | undefined)[] = [];
  const qm = fakeQm({
    claimDeliveries: async (type) => (type === 'principal' ? [delivery({ type: 'principal', target: 'user:ou_test_1' })] : []),
    ackDelivery: async (_id, receipt) => {
      receipts.push(receipt);
    },
  });
  const feishu = fakeFeishu({
    send: async () => ({ messageId: 'om_test_reply_1', chatId: 'oc_test_dm_1' }),
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu, claimPrincipalDeliveries: true });

  await dispatcher.poll();

  assert.deepEqual(receipts, [{ threadRef: 'feishu:dm:oc_test_dm_1' }]);
});

// --- multi-part text and all-parts-before-ack -----------------------------

test('every required text part is sent, with stable UUIDs, before acknowledgement', async () => {
  const sent: OutgoingMessage[] = [];
  let acked = 0;
  const qm = fakeQm({
    claimDeliveries: async () => [delivery({ text: 'hello world' })],
    ackDelivery: async () => {
      acked += 1;
    },
  });
  const feishu = fakeFeishu({
    send: async (_target, message: OutgoingMessage) => {
      sent.push(message);
      return { messageId: `om_test_part_${String(sent.length)}` };
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu, maxPartChars: 5 });

  await dispatcher.poll();

  assert.deepEqual(
    sent.map((message) => (message.kind === 'text' ? message.text : undefined)),
    ['hello', ' worl', 'd'],
  );
  assert.deepEqual(
    sent.map((message) => message.uuid),
    [derivePartUuid('key_test_1', 0, 'text'), derivePartUuid('key_test_1', 1, 'text'), derivePartUuid('key_test_1', 2, 'text')],
  );
  assert.equal(acked, 1);
});

test('retrying a delivery reuses the same UUIDs and part boundaries', async () => {
  const firstPass: OutgoingMessage[] = [];
  const secondPass: OutgoingMessage[] = [];
  let attempt = 0;
  const qm = fakeQm({
    claimDeliveries: async () => [delivery({ text: 'hello world' })],
  });
  const feishu = fakeFeishu({
    send: async (_target, message: OutgoingMessage) => {
      (attempt === 0 ? firstPass : secondPass).push(message);
      return { messageId: 'om_test_reply_1' };
    },
  });

  const first = new FeishuDeliveryDispatcher({ qm, feishu, maxPartChars: 5 });
  await first.poll();

  attempt = 1;
  const retry = new FeishuDeliveryDispatcher({ qm, feishu, maxPartChars: 5 });
  await retry.poll();

  assert.deepEqual(firstPass, secondPass);
});

test('a failed part leaves the delivery unacknowledged and stops sending later parts', async () => {
  const sent: string[] = [];
  let acked = 0;
  let ackedByKey = 0;
  const qm = fakeQm({
    claimDeliveries: async () => [delivery({ text: 'hello world' })],
    ackDelivery: async () => {
      acked += 1;
    },
    ackDeliveryByKey: async () => {
      ackedByKey += 1;
    },
  });
  const feishu = fakeFeishu({
    send: async (_target, message: OutgoingMessage) => {
      const text = message.kind === 'text' ? message.text : '';
      sent.push(text);
      if (sent.length === 2) throw new Error('transient feishu failure');
      return { messageId: 'om_test_reply_1' };
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu, maxPartChars: 5 });

  await dispatcher.poll();

  assert.deepEqual(sent, ['hello', ' worl']);
  assert.equal(acked, 0);
  assert.equal(ackedByKey, 0);
});

// --- ack-by-key recovery --------------------------------------------------

test('a lost delivery acknowledgement recovers through ack-by-key', async () => {
  let ackCalls = 0;
  const ackByKeyCalls: string[] = [];
  const qm = fakeQm({
    claimDeliveries: async () => [delivery()],
    ackDelivery: async () => {
      ackCalls += 1;
      throw new Error('qm ack endpoint unavailable');
    },
    ackDeliveryByKey: async (idempotencyKey) => {
      ackByKeyCalls.push(idempotencyKey);
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu: fakeFeishu() });

  await dispatcher.poll();

  assert.equal(ackCalls, 1);
  assert.deepEqual(ackByKeyCalls, ['key_test_1']);
});

// --- serialization and independent progress -------------------------------

test('same-destination deliveries send in order', async () => {
  const order: string[] = [];
  const gate = deferred<void>();
  const qm = fakeQm({
    claimDeliveries: async () => [
      delivery({ id: 'delivery_test_1', idempotencyKey: 'key_test_1', text: 'first' }),
      delivery({ id: 'delivery_test_2', idempotencyKey: 'key_test_2', text: 'second' }),
    ],
  });
  const feishu = fakeFeishu({
    send: async (_target, message: OutgoingMessage) => {
      const text = message.kind === 'text' ? message.text : '';
      order.push(`start:${text}`);
      if (text === 'first') await gate.promise;
      order.push(`end:${text}`);
      return { messageId: 'om_test_reply_1' };
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu });

  const pollDone = dispatcher.poll();
  await delay(10);
  assert.deepEqual(order, ['start:first']);

  gate.resolve();
  await pollDone;
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
});

test('different-destination deliveries progress independently', async () => {
  const order: string[] = [];
  const gate = deferred<void>();
  const qm = fakeQm({
    claimDeliveries: async () => [
      delivery({ id: 'delivery_test_1', target: 'chat:oc_test_1:message:om_test_1', text: 'first' }),
      delivery({ id: 'delivery_test_2', idempotencyKey: 'key_test_2', target: 'chat:oc_test_2:message:om_test_2', text: 'second' }),
    ],
  });
  const feishu = fakeFeishu({
    send: async (_target, message: OutgoingMessage) => {
      const text = message.kind === 'text' ? message.text : '';
      order.push(`start:${text}`);
      if (text === 'first') await gate.promise;
      order.push(`end:${text}`);
      return { messageId: 'om_test_reply_1' };
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu });

  const pollDone = dispatcher.poll();
  await delay(10);
  assert.deepEqual(order, ['start:first', 'start:second', 'end:second']);

  gate.resolve();
  await pollDone;
  assert.deepEqual(order, ['start:first', 'start:second', 'end:second', 'end:first']);
});

// --- transient failure and duplicate claim guard --------------------------

test('a transient Feishu failure leaves the delivery unacknowledged', async () => {
  let acked = 0;
  let ackedByKey = 0;
  const qm = fakeQm({
    claimDeliveries: async () => [delivery()],
    ackDelivery: async () => {
      acked += 1;
    },
    ackDeliveryByKey: async () => {
      ackedByKey += 1;
    },
  });
  const feishu = fakeFeishu({
    send: async () => {
      throw new Error('ECONNRESET');
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu });

  await dispatcher.poll();

  assert.equal(acked, 0);
  assert.equal(ackedByKey, 0);
});

test('a permanent Feishu failure is terminally acknowledged without logging its message', async () => {
  const logs: Array<Record<string, unknown>> = [];
  let acked = 0;
  const qm = fakeQm({
    claimDeliveries: async () => [delivery()],
    ackDelivery: async () => {
      acked += 1;
    },
  });
  const permanent = Object.assign(new Error('secret message body'), { disposition: 'permanent' as const });
  const feishu = fakeFeishu({ send: async () => Promise.reject(permanent) });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu, log: (event) => logs.push(event) });

  await dispatcher.poll();

  assert.equal(acked, 1);
  assert.ok(logs.some((event) => event.event === 'delivery_terminal'));
  assert.doesNotMatch(JSON.stringify(logs), /secret message body/);
});

test('duplicate poll ticks do not concurrently send the same in-flight delivery twice', async () => {
  let sendCalls = 0;
  const gate = deferred<void>();
  const qm = fakeQm({
    claimDeliveries: async () => [delivery()],
  });
  const feishu = fakeFeishu({
    send: async () => {
      sendCalls += 1;
      await gate.promise;
      return { messageId: 'om_test_reply_1' };
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu });

  const firstPoll = dispatcher.poll();
  await delay(10);
  const secondPoll = dispatcher.poll();
  await secondPoll;

  assert.equal(sendCalls, 1);

  gate.resolve();
  await firstPoll;
});

// --- bounded drain shutdown -------------------------------------------------

test('stop waits for a poll that is still claiming deliveries', async () => {
  const claimGate = deferred<Delivery[]>();
  const qm = fakeQm({ claimDeliveries: async () => claimGate.promise });
  const feishu = fakeFeishu();
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu, shutdownTimeoutMs: 100 });

  const poll = dispatcher.poll();
  const stopped = dispatcher.stop();
  let stopResolved = false;
  stopped.then(() => {
    stopResolved = true;
  });
  await delay(10);
  assert.equal(stopResolved, false);

  claimGate.resolve([]);
  await Promise.all([poll, stopped]);
});
test('stop blocks new claims and drains active sends within a bounded timeout', async () => {
  const gate = deferred<void>();
  let claimCalls = 0;
  const qm = fakeQm({
    claimDeliveries: async () => {
      claimCalls += 1;
      return claimCalls === 1 ? [delivery()] : [];
    },
  });
  const feishu = fakeFeishu({
    send: async () => {
      await gate.promise;
      return { messageId: 'om_test_reply_1' };
    },
  });
  const dispatcher = new FeishuDeliveryDispatcher({ qm, feishu, shutdownTimeoutMs: 20 });

  const firstPoll = dispatcher.poll();
  await delay(10);

  const stopped = dispatcher.stop();
  await stopped;

  await dispatcher.poll();
  assert.equal(claimCalls, 1, 'poll after stop must not claim new deliveries');

  gate.resolve();
  await firstPoll;
});
