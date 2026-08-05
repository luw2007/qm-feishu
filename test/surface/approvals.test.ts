import assert from 'node:assert/strict';
import test from 'node:test';

import { renderApprovalCard } from '../../src/feishu/cards.js';
import type { FeishuPort, QmPort } from '../../src/ports.js';
import type {
  ApprovalView,
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
import {
  FeishuContractError,
  FeishuPermanentError,
  FeishuRateLimitedError,
  FeishuTransientError,
  FeishuUnavailableError,
} from '../../src/feishu/client.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    request: {
      actor: { externalId: 'ou_test_requester_1', displayName: 'Ann' },
      surface: 'feishu',
      deliveryTarget: 'chat:oc_test_dm_1:message:om_test_1',
      conversation: {
        kind: 'dm',
        threadRef: 'feishu:dm:oc_test_dm_1',
        channelRef: 'oc_test_dm_1',
      },
    },
    ...overrides,
  };
}

function actionFixture(overrides: Partial<NormalizedCardAction> = {}): NormalizedCardAction {
  return {
    eventId: 'evt_test_1',
    tenantKey: 'tenant_test_1',
    appId: 'cli_test_app',
    operatorOpenId: 'ou_test_requester_1',
    operatorTenantKey: 'tenant_test_1',
    requestId: 'req_test_1',
    action: 'allow_once',
    ...overrides,
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

test('renderApprovalCard shows untrusted command content as plain text', () => {
  const card = renderApprovalCard(approvalFixture({ command: '` [spoof](https://attacker.invalid) @all' }));
  const elements = card.card.elements as Array<Record<string, unknown>>;
  const text = elements[0]?.text as Record<string, unknown>;
  assert.equal(text.tag, 'plain_text');
  assert.equal(text.content, 'Approval requested:\n` [spoof](https://attacker.invalid) @all');
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

test('watchApproval emits one sanitized terminal notice for failed and aborted accepted runs', async () => {
  for (const status of ['failed', 'aborted'] as const) {
    const sent: OutgoingMessage[] = [];
    const qm = fakeQm({
      pendingApproval: async () => null,
      getRun: async () => ({ runId: 'run_sensitive_1', status }),
    });
    const feishu = fakeFeishu({
      send: async (_target, message) => {
        sent.push(message);
        return { messageId: 'om_test_terminal_1' };
      },
    });

    const outcome = await watchApproval(
      { runId: 'run_sensitive_1', threadRef: 'feishu:dm:oc_test_dm_1', destination: 'chat:oc_test_dm_1:message:om_test_1' },
      { qm, feishu },
      { renderCard: renderApprovalCard },
    );

    const expectedText = status === 'failed' ? 'The run failed.' : 'The run was stopped.';
    assert.deepEqual(outcome, { kind: 'terminal', status });
    assert.deepEqual(sent, [{
      kind: 'text',
      text: expectedText,
      uuid: `terminal:${status}:run_sensitive_1`,
    }]);
    assert.doesNotMatch(expectedText, /sensitive/);
  }
});

test('watchApproval checks authoritative pending approval before terminal state for collect-mode runs', async () => {
  const order: string[] = [];
  let sendCalls = 0;
  const qm = fakeQm({
    pendingApproval: async () => {
      order.push('pendingApproval');
      return approvalFixture();
    },
    getRun: async () => {
      order.push('getRun');
      return { runId: 'run_test_1', status: 'completed' };
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
    { renderCard: renderApprovalCard },
  );

  assert.deepEqual(outcome, { kind: 'card_sent', requestId: 'req_test_1' });
  assert.deepEqual(order, ['pendingApproval']);
  assert.equal(sendCalls, 1);
});

test('watchApproval retries transient Feishu sends but never retries permanent or contract failures', async () => {
  for (const transientError of [
    new FeishuRateLimitedError(429),
    new FeishuTransientError(503),
    new FeishuUnavailableError(),
  ]) {
    let sendCalls = 0;
    const qm = fakeQm({ pendingApproval: async () => approvalFixture() });
    const feishu = fakeFeishu({
      send: async () => {
        sendCalls += 1;
        if (sendCalls === 1) throw transientError;
        return { messageId: 'om_test_card_1' };
      },
    });

    assert.deepEqual(
      await watchApproval(
        { runId: 'run_test_1', threadRef: 'feishu:dm:oc_test_dm_1', destination: 'chat:oc_test_dm_1:message:om_test_1' },
        { qm, feishu },
        { renderCard: renderApprovalCard, pollIntervalMs: 1 },
      ),
      { kind: 'card_sent', requestId: 'req_test_1' },
    );
    assert.equal(sendCalls, 2);
  }

  for (const terminalError of [new FeishuPermanentError(400), new FeishuContractError('bad receipt')]) {
    let sendCalls = 0;
    const qm = fakeQm({ pendingApproval: async () => approvalFixture() });
    const feishu = fakeFeishu({
      send: async () => {
        sendCalls += 1;
        throw terminalError;
      },
    });
    await assert.rejects(
      watchApproval(
        { runId: 'run_test_1', threadRef: 'feishu:dm:oc_test_dm_1', destination: 'chat:oc_test_dm_1:message:om_test_1' },
        { qm, feishu },
        { renderCard: renderApprovalCard, pollIntervalMs: 1 },
      ),
      terminalError.constructor,
    );
    assert.equal(sendCalls, 1);
  }
});

test('watchApproval retries structurally transient QM failures but fails immediately on permanent failures', async () => {
  let transientCalls = 0;
  const transientQm = fakeQm({
    pendingApproval: async () => {
      transientCalls += 1;
      if (transientCalls === 1) throw Object.assign(new Error('QM unavailable'), { disposition: 'transient' as const });
      return approvalFixture();
    },
  });
  const feishu = fakeFeishu({ send: async () => ({ messageId: 'om_test_card_1' }) });

  assert.deepEqual(
    await watchApproval(
      { runId: 'run_test_1', threadRef: 'feishu:dm:oc_test_dm_1', destination: 'chat:oc_test_dm_1:message:om_test_1' },
      { qm: transientQm, feishu },
      { renderCard: renderApprovalCard, pollIntervalMs: 1 },
    ),
    { kind: 'card_sent', requestId: 'req_test_1' },
  );
  assert.equal(transientCalls, 2);

  let permanentCalls = 0;
  const permanentQm = fakeQm({
    pendingApproval: async () => {
      permanentCalls += 1;
      throw Object.assign(new Error('QM rejected'), { disposition: 'permanent' as const });
    },
  });
  await assert.rejects(
    watchApproval(
      { runId: 'run_test_1', threadRef: 'feishu:dm:oc_test_dm_1', destination: 'chat:oc_test_dm_1:message:om_test_1' },
      { qm: permanentQm, feishu },
      { renderCard: renderApprovalCard, pollIntervalMs: 1 },
    ),
    { disposition: 'permanent' },
  );
  assert.equal(permanentCalls, 1);
});

// --- handleCardAction: callback waits only for durable queue acceptance --

test('handleCardAction waits for durable QM continuation acceptance and returns watcher context', async () => {
  const gate = deferred<{ runId: string; queued: true }>();
  const qm = fakeQm({
    getApproval: async () => approvalFixture(),
    submitTurn: async () => gate.promise,
  });

  const result = handleCardAction(actionFixture(), { qm }, { deadlineMs: 100 });
  assert.equal(await Promise.race([result.then(() => 'settled'), delay(10).then(() => 'pending')]), 'pending');

  gate.resolve({ runId: 'run_continuation_1', queued: true });
  assert.deepEqual(await result, {
    response: { toast: { type: 'success', content: 'Approved.' } },
    outcome: { kind: 'accepted', requestId: 'req_test_1', scope: 'once' },
    continuation: {
      runId: 'run_continuation_1',
      threadRef: 'feishu:dm:oc_test_dm_1',
      destination: 'chat:oc_test_dm_1:message:om_test_1',
    },
  });
});

test('handleCardAction treats a completed QM idempotency replay as success without inventing watcher context', async () => {
  const result = await handleCardAction(actionFixture(), {
    qm: fakeQm({
      getApproval: async () => approvalFixture(),
      submitTurn: async () => ({ replayed: true }),
    }),
  });

  assert.deepEqual(result, {
    response: { toast: { type: 'success', content: 'Approved.' } },
    outcome: { kind: 'accepted', requestId: 'req_test_1', scope: 'once' },
  });
});

test('handleCardAction deadline returns an error immediately but exposes a controlled late queued continuation', async () => {
  const queued = deferred<{ runId: string; queued: true }>();
  const timeoutResult = await handleCardAction(
    actionFixture(),
    { qm: fakeQm({ getApproval: async () => approvalFixture(), submitTurn: async () => queued.promise }) },
    { deadlineMs: 5 },
  );
  assert.equal(timeoutResult.response.toast.type, 'error');
  assert.equal(timeoutResult.outcome.kind, 'failed');
  assert.equal(timeoutResult.continuation, undefined);
  assert.ok(timeoutResult.lateContinuation);

  queued.resolve({ runId: 'run_late_1', queued: true });
  assert.deepEqual(await timeoutResult.lateContinuation, {
    runId: 'run_late_1',
    threadRef: 'feishu:dm:oc_test_dm_1',
    destination: 'chat:oc_test_dm_1:message:om_test_1',
  });
});

test('handleCardAction consumes a late submit rejection without claiming success', async () => {
  const queued = deferred<{ runId: string; queued: true }>();
  const events: Record<string, unknown>[] = [];
  const timeoutResult = await handleCardAction(
    actionFixture(),
    { qm: fakeQm({ getApproval: async () => approvalFixture(), submitTurn: async () => queued.promise }) },
    { deadlineMs: 5, log: (event) => events.push(event) },
  );

  queued.reject(new Error('sensitive late failure'));
  assert.equal(await timeoutResult.lateContinuation, undefined);
  assert.equal(timeoutResult.response.toast.type, 'error');
  assert.equal(events.some((event) => event.event === 'approval_continuation_late_failed'), true);
});

test('handleCardAction deadline defaults to 2500ms and never claims success on submission failure', async () => {
  const failureResult = await handleCardAction(
    actionFixture(),
    { qm: fakeQm({
      getApproval: async () => approvalFixture(),
      submitTurn: async () => { throw new Error('sensitive upstream body'); },
    }) },
  );
  assert.equal(failureResult.response.toast.type, 'error');
  assert.equal(failureResult.outcome.kind, 'failed');
  assert.equal(failureResult.response.toast.content.includes('sensitive'), false);
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
    const { outcome } = await handleCardAction(actionFixture({ action }), { qm });
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

  const { outcome } = await handleCardAction(actionFixture({ action: 'deny' }), { qm });

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

  await handleCardAction(actionFixture(), { qm });

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

  const { outcome } = await handleCardAction(actionFixture({ operatorOpenId: 'ou_test_impostor_1' }), { qm });

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

  const { outcome } = await handleCardAction(actionFixture(), { qm });

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

  const { outcome } = await handleCardAction(actionFixture(), { qm });

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

  const { outcome } = await handleCardAction(actionFixture(), { qm });

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

  const { outcome } = await handleCardAction(actionFixture({ action: 'allow_session' }), { qm });

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

  await handleCardAction(action, { qm });
  await handleCardAction(action, { qm });
  await delay(5);

  assert.equal(submitted.length, 2);
  assert.equal(submitted[0]?.idempotencyKey, submitted[1]?.idempotencyKey);
  assert.equal(submitted[0]?.idempotencyKey, 'feishu:approval:req_test_1:allow_once:evt_test_1');
});
