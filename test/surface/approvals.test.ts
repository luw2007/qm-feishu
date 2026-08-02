import assert from 'node:assert/strict';
import test from 'node:test';

import { renderApprovalCard } from '../../src/feishu/cards.js';
import type { FeishuPort, QmPort } from '../../src/ports.js';
import type {
  ApprovalView,
  FeishuConversation,
  FeishuTarget,
  NormalizedCardAction,
  OutgoingMessage,
  RunView,
  SurfaceTurn,
} from '../../src/types.js';
import {
  deriveApprovalIdempotencyKey,
  handleCardAction,
  watchApproval,
} from '../../src/surface/approvals.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`unused: ${name}`);
  };
}

function fakeQm(overrides: Partial<QmPort> = {}): QmPort {
  return {
    probe: notImplemented('probe'),
    submitTurn: notImplemented('submitTurn'),
    getRun: notImplemented('getRun'),
    activeRun: notImplemented('activeRun'),
    signalRun: notImplemented('signalRun'),
    claimDeliveries: notImplemented('claimDeliveries'),
    ackDelivery: notImplemented('ackDelivery'),
    ackDeliveryByKey: notImplemented('ackDeliveryByKey'),
    pendingApproval: notImplemented('pendingApproval'),
    getApproval: notImplemented('getApproval'),
    stageBlob: notImplemented('stageBlob'),
    readBlob: notImplemented('readBlob'),
    readFileArtifact: notImplemented('readFileArtifact'),
    pushDirectory: notImplemented('pushDirectory'),
    ingestSurfaceEvents: notImplemented('ingestSurfaceEvents'),
    ...overrides,
  };
}

function fakeFeishu(overrides: Partial<FeishuPort> = {}): FeishuPort {
  return {
    probe: notImplemented('probe'),
    reply: notImplemented('reply'),
    send: notImplemented('send'),
    update: notImplemented('update'),
    download: notImplemented('download'),
    upload: notImplemented('upload'),
    ...overrides,
  };
}

function approvalFixture(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    requestId: 'req_test_1',
    status: 'pending',
    command: 'rm -rf /tmp/scratch',
    grantModes: { once: true, session: true, always: true },
    request: { actor: { externalId: 'ou_test_requester_1', displayName: 'Ann' } },
    ...overrides,
  };
}

function actionFixture(overrides: Partial<NormalizedCardAction> = {}): NormalizedCardAction {
  return {
    eventId: 'evt_test_1',
    operatorOpenId: 'ou_test_requester_1',
    requestId: 'req_test_1',
    action: 'allow_once',
    ...overrides,
  };
}

function contextFixture(): { threadRef: string; destination: string; conversation: FeishuConversation } {
  return {
    threadRef: 'feishu:dm:oc_test_dm_1',
    destination: 'chat:oc_test_dm_1:message:om_test_1',
    conversation: { id: 'oc_test_dm_1', kind: 'dm' },
  };
}

function cardButtons(card: Record<string, unknown>): Array<{ action?: unknown; requestId?: unknown } & Record<string, unknown>> {
  const elements = card.elements as Array<Record<string, unknown>>;
  const actionBlock = elements.find((element) => element.tag === 'action');
  const actions = (actionBlock?.actions ?? []) as Array<Record<string, unknown>>;
  return actions.map((button) => button.value as Record<string, unknown>);
}

// --- renderApprovalCard: allowed scopes and card-value authority --------

test('renderApprovalCard exposes allow-once, allow-session, allow-always, and deny when all modes are granted', () => {
  const card = renderApprovalCard(approvalFixture());
  const values = cardButtons(card.card);
  assert.deepEqual(
    values.map((value) => value.action).sort(),
    ['allow_always', 'allow_once', 'allow_session', 'deny'].sort(),
  );
});

test('renderApprovalCard omits ungranted scopes', () => {
  const card = renderApprovalCard(approvalFixture({ grantModes: { once: true, session: false, always: false } }));
  const values = cardButtons(card.card);
  assert.deepEqual(
    values.map((value) => value.action).sort(),
    ['allow_once', 'deny'].sort(),
  );
});

test('renderApprovalCard binds only requestId and action to each button value', () => {
  const card = renderApprovalCard(approvalFixture());
  const values = cardButtons(card.card);
  assert.ok(values.length > 0);
  for (const value of values) {
    assert.deepEqual(Object.keys(value).sort(), ['action', 'requestId']);
    assert.equal(value.requestId, 'req_test_1');
  }
});

test('renderApprovalCard never leaks actor or command authority into the card values', () => {
  const card = renderApprovalCard(approvalFixture());
  const values = cardButtons(card.card);
  for (const value of values) {
    assert.equal('actor' in value, false);
    assert.equal('command' in value, false);
    assert.equal('externalId' in value, false);
  }
});

// --- deriveApprovalIdempotencyKey ----------------------------------------

test('deriveApprovalIdempotencyKey is stable for identical inputs and varies with any input', () => {
  const key = deriveApprovalIdempotencyKey('req_1', 'allow_once', 'evt_1');
  assert.equal(key, 'feishu:approval:req_1:allow_once:evt_1');
  assert.equal(key, deriveApprovalIdempotencyKey('req_1', 'allow_once', 'evt_1'));
  assert.notEqual(key, deriveApprovalIdempotencyKey('req_1', 'allow_once', 'evt_2'));
  assert.notEqual(key, deriveApprovalIdempotencyKey('req_1', 'deny', 'evt_1'));
  assert.notEqual(key, deriveApprovalIdempotencyKey('req_2', 'allow_once', 'evt_1'));
});

// --- watchApproval: poll until terminal/approval, exactly one card ------

test('watchApproval sends exactly one card as soon as a pending approval appears', async () => {
  const sentTargets: FeishuTarget[] = [];
  const sentMessages: OutgoingMessage[] = [];
  const qm = fakeQm({
    getRun: async () => ({ runId: 'run_test_1', status: 'running' }) as RunView,
    pendingApproval: async () => approvalFixture(),
  });
  const feishu = fakeFeishu({
    send: async (target, message) => {
      sentTargets.push(target);
      sentMessages.push(message);
      return { messageId: 'om_test_card_1' };
    },
  });

  const outcome = await watchApproval(
    { runId: 'run_test_1', threadRef: 'feishu:dm:oc_test_dm_1', destination: 'chat:oc_test_dm_1:message:om_test_1' },
    { qm, feishu },
    { renderCard: renderApprovalCard },
  );

  assert.deepEqual(outcome, { kind: 'card_sent', requestId: 'req_test_1' });
  assert.equal(sentTargets.length, 1);
  assert.deepEqual(sentTargets[0], { kind: 'reply', chatId: 'oc_test_dm_1', messageId: 'om_test_1' });
  assert.equal(sentMessages[0]?.kind, 'card');
});

test('watchApproval polls pendingApproval repeatedly and still sends exactly one card once it appears', async () => {
  let pendingCalls = 0;
  let sendCalls = 0;
  const qm = fakeQm({
    getRun: async () => ({ runId: 'run_test_1', status: 'running' }) as RunView,
    pendingApproval: async () => {
      pendingCalls += 1;
      return pendingCalls < 3 ? null : approvalFixture();
    },
  });
  const feishu = fakeFeishu({
    send: async () => {
      sendCalls += 1;
      return { messageId: 'om_test_card_1' };
    },
  });

  const outcome = await watchApproval(
    { runId: 'run_test_1', threadRef: 'feishu:dm:oc_test_dm_1', destination: 'chat:oc_test_dm_1:message:om_test_1' },
    { qm, feishu },
    { renderCard: renderApprovalCard, pollIntervalMs: 1 },
  );

  assert.deepEqual(outcome, { kind: 'card_sent', requestId: 'req_test_1' });
  assert.equal(pendingCalls, 3);
  assert.equal(sendCalls, 1);
});

test('watchApproval stops polling once the run reaches a terminal state without ever showing an approval', async () => {
  let getRunCalls = 0;
  let sendCalls = 0;
  const qm = fakeQm({
    getRun: async () => {
      getRunCalls += 1;
      return { runId: 'run_test_1', status: getRunCalls < 3 ? 'running' : 'completed' } as RunView;
    },
    pendingApproval: async () => null,
  });
  const feishu = fakeFeishu({
    send: async () => {
      sendCalls += 1;
      return { messageId: 'om_test_card_1' };
    },
  });

  const outcome = await watchApproval(
    { runId: 'run_test_1', threadRef: 'feishu:dm:oc_test_dm_1', destination: 'chat:oc_test_dm_1:message:om_test_1' },
    { qm, feishu },
    { renderCard: renderApprovalCard, pollIntervalMs: 1 },
  );

  assert.deepEqual(outcome, { kind: 'terminal', status: 'completed' });
  assert.equal(getRunCalls, 3);
  assert.equal(sendCalls, 0);
});

// --- handleCardAction: callback response precedes QM continuation -------

test('handleCardAction returns its response before the QM continuation settles', async () => {
  const gate = deferred<{ runId: string; queued: true }>();
  let submitTurnCalled = false;
  const qm = fakeQm({
    getApproval: async () => approvalFixture(),
    submitTurn: async (turn) => {
      submitTurnCalled = true;
      void turn;
      return gate.promise;
    },
  });

  const result = await Promise.race([
    handleCardAction(actionFixture(), contextFixture(), { qm }),
    delay(50).then(() => 'timed_out' as const),
  ]);

  assert.notEqual(result, 'timed_out');
  assert.equal(submitTurnCalled, true);
  gate.resolve({ runId: 'run_test_1', queued: true });
});

// --- handleCardAction: reload + actor verification, fail-closed ---------

test('handleCardAction accepts a matching operator and maps the scope exactly', async () => {
  const submitted: SurfaceTurn[] = [];
  const qm = fakeQm({
    getApproval: async () => approvalFixture(),
    submitTurn: async (turn) => {
      submitted.push(turn);
      return { runId: 'run_test_1', queued: true };
    },
  });

  for (const [action, scope] of [
    ['allow_once', 'once'],
    ['allow_session', 'session'],
    ['allow_always', 'always'],
  ] as const) {
    const { outcome } = await handleCardAction(actionFixture({ action }), contextFixture(), { qm });
    assert.deepEqual(outcome, { kind: 'accepted', requestId: 'req_test_1', scope });
  }
  await delay(5);
  assert.equal(submitted.length, 3);
  assert.deepEqual(
    submitted.map((turn) => turn.approval),
    [
      { requestId: 'req_test_1', approved: true, scope: 'once' },
      { requestId: 'req_test_1', approved: true, scope: 'session' },
      { requestId: 'req_test_1', approved: true, scope: 'always' },
    ],
  );
});

test('handleCardAction: deny never carries an approval scope', async () => {
  const submitted: SurfaceTurn[] = [];
  const qm = fakeQm({
    getApproval: async () => approvalFixture(),
    submitTurn: async (turn) => {
      submitted.push(turn);
      return { runId: 'run_test_1', queued: true };
    },
  });

  const { outcome } = await handleCardAction(actionFixture({ action: 'deny' }), contextFixture(), { qm });

  assert.deepEqual(outcome, { kind: 'denied', requestId: 'req_test_1' });
  await delay(5);
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0]?.approval, { requestId: 'req_test_1', approved: false });
  assert.equal('scope' in submitted[0].approval!, false);
});

test('handleCardAction reloads the current approval from QM rather than trusting the callback value', async () => {
  let getApprovalCalls = 0;
  const qm = fakeQm({
    getApproval: async (requestId) => {
      getApprovalCalls += 1;
      assert.equal(requestId, 'req_test_1');
      return approvalFixture();
    },
    submitTurn: async () => ({ runId: 'run_test_1', queued: true }),
  });

  await handleCardAction(actionFixture(), contextFixture(), { qm });

  assert.equal(getApprovalCalls, 1);
});

test('handleCardAction fails closed and never continues when the operator does not match the requester', async () => {
  let submitTurnCalls = 0;
  const qm = fakeQm({
    getApproval: async () => approvalFixture({ request: { actor: { externalId: 'ou_test_requester_1' } } }),
    submitTurn: async () => {
      submitTurnCalls += 1;
      return { runId: 'run_test_1', queued: true };
    },
  });

  const { outcome } = await handleCardAction(actionFixture({ operatorOpenId: 'ou_test_impostor_1' }), contextFixture(), { qm });

  assert.deepEqual(outcome, { kind: 'mismatch', requestId: 'req_test_1' });
  assert.equal(submitTurnCalls, 0);
});

test('handleCardAction fails closed when the approval has no originating request', async () => {
  let submitTurnCalls = 0;
  const withoutRequest = approvalFixture();
  delete withoutRequest.request;
  const qm = fakeQm({
    getApproval: async () => withoutRequest,
    submitTurn: async () => {
      submitTurnCalls += 1;
      return { runId: 'run_test_1', queued: true };
    },
  });

  const { outcome } = await handleCardAction(actionFixture(), contextFixture(), { qm });

  assert.deepEqual(outcome, { kind: 'mismatch', requestId: 'req_test_1' });
  assert.equal(submitTurnCalls, 0);
});

test('handleCardAction fails closed when the approval is no longer pending (stale)', async () => {
  let submitTurnCalls = 0;
  const qm = fakeQm({
    getApproval: async () => approvalFixture({ status: 'approved' }),
    submitTurn: async () => {
      submitTurnCalls += 1;
      return { runId: 'run_test_1', queued: true };
    },
  });

  const { outcome } = await handleCardAction(actionFixture(), contextFixture(), { qm });

  assert.deepEqual(outcome, { kind: 'stale', requestId: 'req_test_1' });
  assert.equal(submitTurnCalls, 0);
});

test('handleCardAction fails closed when the approval no longer exists', async () => {
  let submitTurnCalls = 0;
  const qm = fakeQm({
    getApproval: async () => null,
    submitTurn: async () => {
      submitTurnCalls += 1;
      return { runId: 'run_test_1', queued: true };
    },
  });

  const { outcome } = await handleCardAction(actionFixture(), contextFixture(), { qm });

  assert.deepEqual(outcome, { kind: 'missing', requestId: 'req_test_1' });
  assert.equal(submitTurnCalls, 0);
});

test('handleCardAction fails closed when the requested scope was never granted (malformed)', async () => {
  let submitTurnCalls = 0;
  const qm = fakeQm({
    getApproval: async () => approvalFixture({ grantModes: { once: true, session: false, always: false } }),
    submitTurn: async () => {
      submitTurnCalls += 1;
      return { runId: 'run_test_1', queued: true };
    },
  });

  const { outcome } = await handleCardAction(actionFixture({ action: 'allow_session' }), contextFixture(), { qm });

  assert.deepEqual(outcome, { kind: 'malformed', requestId: 'req_test_1' });
  assert.equal(submitTurnCalls, 0);
});

// --- idempotency across repeated callbacks -------------------------------

test('handleCardAction: repeated identical callbacks derive the same continuation idempotency key', async () => {
  const submitted: SurfaceTurn[] = [];
  const qm = fakeQm({
    getApproval: async () => approvalFixture(),
    submitTurn: async (turn) => {
      submitted.push(turn);
      return { runId: 'run_test_1', queued: true };
    },
  });
  const action = actionFixture();

  await handleCardAction(action, contextFixture(), { qm });
  await handleCardAction(action, contextFixture(), { qm });
  await delay(5);

  assert.equal(submitted.length, 2);
  assert.equal(submitted[0]?.idempotencyKey, submitted[1]?.idempotencyKey);
  assert.equal(submitted[0]?.idempotencyKey, 'feishu:approval:req_test_1:allow_once:evt_test_1');
});
