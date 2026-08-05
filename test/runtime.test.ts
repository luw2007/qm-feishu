import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeishuSurfaceConfig } from '../src/config.ts';
import type { HealthServer } from '../src/health.ts';
import type { Logger } from '../src/logging.ts';
import type { FeishuEventSource, FeishuPort, QmPort } from '../src/ports.ts';
import type { RuntimeDeps } from '../src/runtime.ts';
import { runFeishuSurface } from '../src/runtime.ts';
import type { ApprovalView, Delivery, OutgoingMessage } from '../src/types.ts';

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

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await delay(5);
  }
}

function testConfig(overrides: Partial<FeishuSurfaceConfig> = {}): FeishuSurfaceConfig {
  return {
    coreApiUrl: 'http://127.0.0.1:19090',
    coreSigningSecret: 'x'.repeat(32),
    feishuAppId: 'cli_test_app',
    feishuAppSecret: 'secret_test',
    feishuBotOpenId: 'ou_test_bot_1',
    feishuTenantKey: 'tenant_test_1',
    healthHost: '127.0.0.1',
    healthPort: 0,
    deliveryPollMs: 10_000,
    approvalPollMs: 10,
    shutdownTimeoutMs: 200,
    ...overrides,
  };
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
    ingestSurfaceEvents: async () => undefined,
    ...overrides,
  };
}

function fakeFeishu(overrides: Partial<FeishuPort> = {}): FeishuPort {
  return {
    probe: async () => undefined,
    reply: async () => ({ messageId: 'om_test_reply_1' }),
    send: async () => ({ messageId: 'om_test_send_1' }),
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

function controllableEventSource(overrides: Partial<FeishuEventSource> = {}) {
  let handlers: { onMessage(event: unknown): Promise<void>; onCardAction(event: unknown): Promise<unknown> } | undefined;
  let startCalls = 0;
  let stopCalls = 0;
  const source: FeishuEventSource = {
    start: async (h) => {
      startCalls += 1;
      handlers = h;
    },
    stop: async () => {
      stopCalls += 1;
    },
    ...overrides,
  };
  return {
    source,
    get startCalls(): number {
      return startCalls;
    },
    get stopCalls(): number {
      return stopCalls;
    },
    emitMessage(raw: unknown): Promise<void> {
      if (!handlers) throw new Error('event source not started');
      return handlers.onMessage(raw);
    },
    emitCardAction(raw: unknown): Promise<unknown> {
      if (!handlers) throw new Error('event source not started');
      return handlers.onCardAction(raw);
    },
  };
}

function captureLog(): { log: Logger; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  return { log: (event) => events.push(event), events };
}

async function withHealthPort(deps: RuntimeDeps): Promise<{ deps: RuntimeDeps; port(): number }> {
  let captured: HealthServer | undefined;
  const { startHealthServer } = await import('../src/health.ts');
  return {
    port: () => {
      if (!captured) throw new Error('health server not started yet');
      return captured.port;
    },
    deps: {
      ...deps,
      createHealthServer: async (options) => {
        captured = await startHealthServer(options);
        return captured;
      },
    },
  };
}

function messageFixture(overrides: Record<string, unknown> = {}): unknown {
  return {
    event_id: 'evt_test_direct_1',
    token: 'verify_test',
    create_time: '1700000000000',
    event_type: 'im.message.receive_v1',
    tenant_key: 'tenant_test_1',
    app_id: 'cli_test_1',
    sender: {
      sender_id: { open_id: 'ou_test_sender_1', user_id: 'u_test_1' },
      sender_type: 'user',
      tenant_key: 'tenant_test_1',
    },
    message: {
      message_id: 'om_test_direct_1',
      create_time: '1700000000000',
      chat_id: 'oc_test_dm_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello there' }),
    },
    ...overrides,
  };
}

function cardActionFixture(overrides: Record<string, unknown> = {}): unknown {
  return {
    header: {
      event_id: 'evt_test_card_1',
      token: 'verify_test',
      create_time: '1700000006000',
      event_type: 'card.action.trigger',
      tenant_key: 'tenant_test_1',
      app_id: 'cli_test_app',
    },
    event: {
      operator: { open_id: 'ou_test_operator_1', tenant_key: 'tenant_test_1' },
      token: 'verify_test',
      context: { open_message_id: 'om_test_card_1', open_chat_id: 'oc_test_dm_1' },
      action: { tag: 'button', value: { requestId: 'req_test_1', action: 'allow_once' } },
    },
    ...overrides,
  };
}

// --- config validation ------------------------------------------------

void test('runFeishuSurface rejects invalid configuration before touching any port', async () => {
  let qmProbed = false;
  const deps: RuntimeDeps = {
    createQmClient: () => fakeQm({ probe: async () => { qmProbed = true; } }),
  };
  await assert.rejects(runFeishuSurface(testConfig({ coreApiUrl: '' }), deps), /CORE_API_URL is required/);
  assert.equal(qmProbed, false);
});

// --- startup ordering ---------------------------------------------------

void test('startup probes QM then Feishu then starts the event source, in order', async () => {
  const order: string[] = [];
  const eventSource = controllableEventSource();
  const deps: RuntimeDeps = {
    createQmClient: () => fakeQm({ probe: async () => { order.push('qm_probe'); } }),
    createFeishuClient: () => fakeFeishu({ probe: async () => { order.push('feishu_probe'); } }),
    createEventSource: () => controllableEventSource({
      start: async (h) => {
        order.push('event_source_start');
        return eventSource.source.start(h);
      },
    }).source,
  };
  const handle = await runFeishuSurface(testConfig(), deps);
  try {
    assert.deepEqual(order, ['qm_probe', 'feishu_probe', 'event_source_start']);
  } finally {
    await handle.stop();
  }
});

void test('readiness stays unavailable until the event source confirms startup', async () => {
  const started = deferred<void>();
  let startCalls = 0;
  const eventSource = controllableEventSource();
  const withPort = await withHealthPort({
    createQmClient: () => fakeQm(),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => ({
      start: async (handlers) => {
        startCalls += 1;
        await eventSource.source.start(handlers);
        await started.promise;
      },
      stop: eventSource.source.stop.bind(eventSource.source),
    }),
  });

  const pending = runFeishuSurface(testConfig(), withPort.deps);
  await waitFor(() => startCalls === 1);
  const base = `http://127.0.0.1:${withPort.port()}`;
  assert.equal((await fetch(`${base}/readyz`)).status, 503);

  started.resolve();
  const handle = await pending;
  try {
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  } finally {
    await handle.stop();
  }
});

void test('a QM probe failure keeps liveness up and retries before probing Feishu', async () => {
  let qmAvailable = false;
  let qmProbes = 0;
  let feishuProbes = 0;
  const eventSource = controllableEventSource();
  const withPort = await withHealthPort({
    createQmClient: () => fakeQm({
      probe: async () => {
        qmProbes += 1;
        if (!qmAvailable) throw new Error('qm unreachable');
      },
    }),
    createFeishuClient: () => fakeFeishu({ probe: async () => { feishuProbes += 1; } }),
    createEventSource: () => eventSource.source,
  });
  const handle = await runFeishuSurface(testConfig({ deliveryPollMs: 20 }), withPort.deps);
  try {
    const base = `http://127.0.0.1:${withPort.port()}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal(feishuProbes, 0);
    assert.equal(eventSource.startCalls, 0);

    qmAvailable = true;
    await waitFor(() => eventSource.startCalls === 1);
    assert.ok(qmProbes >= 2);
    assert.equal(feishuProbes, 1);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  } finally {
    await handle.stop();
  }
});

void test('a Feishu probe failure keeps readiness false and starts intake only after recovery', async () => {
  let feishuAvailable = false;
  let feishuProbes = 0;
  const eventSource = controllableEventSource();
  const withPort = await withHealthPort({
    createQmClient: () => fakeQm(),
    createFeishuClient: () => fakeFeishu({
      probe: async () => {
        feishuProbes += 1;
        if (!feishuAvailable) throw new Error('feishu unreachable');
      },
    }),
    createEventSource: () => eventSource.source,
  });
  const handle = await runFeishuSurface(testConfig({ deliveryPollMs: 20 }), withPort.deps);
  try {
    const base = `http://127.0.0.1:${withPort.port()}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal(eventSource.startCalls, 0);

    feishuAvailable = true;
    await waitFor(() => eventSource.startCalls === 1);
    assert.ok(feishuProbes >= 2);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  } finally {
    await handle.stop();
  }
});

// --- health liveness / readiness ----------------------------------------

void test('liveness is always 200 and readiness is 200 once startup completes', async () => {
  const eventSource = controllableEventSource();
  const withPort = await withHealthPort({
    createQmClient: () => fakeQm(),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => eventSource.source,
  });
  const handle = await runFeishuSurface(testConfig(), withPort.deps);
  try {
    const base = `http://127.0.0.1:${withPort.port()}`;
    const live = await fetch(`${base}/healthz`);
    assert.equal(live.status, 200);
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 200);
  } finally {
    await handle.stop();
  }
});

void test('metrics expose only process-local counters and track terminal delivery disposition', async () => {
  const eventSource = controllableEventSource();
  let claimed = false;
  const withPort = await withHealthPort({
    createQmClient: () => fakeQm({
      claimDeliveries: async () => {
        if (claimed) return [];
        claimed = true;
        return [{ id: 'delivery_metric_1', idempotencyKey: 'metric_key_1', type: 'feishu', target: 'invalid', text: 'ignored' }];
      },
    }),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => eventSource.source,
  });
  const handle = await runFeishuSurface(testConfig(), withPort.deps);
  try {
    const response = await fetch(`http://127.0.0.1:${withPort.port()}/metrics`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      deliveryBacklog: 0,
      deliveryClaims: 1,
      leaseReclaims: 0,
      terminalDispositions: 1,
      approvalWatcherOutcomes: 0,
    });
  } finally {
    await handle.stop();
  }
});

void test('readiness degrades to 503 on delivery-poll connectivity failure and recovers after a successful poll', async () => {
  const eventSource = controllableEventSource();
  let shouldFail = false;
  let claimCalls = 0;
  const withPort = await withHealthPort({
    createQmClient: () =>
      fakeQm({
        claimDeliveries: async () => {
          claimCalls += 1;
          if (shouldFail) throw new Error('qm connectivity lost');
          return [];
        },
      }),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => eventSource.source,
  });
  const handle = await runFeishuSurface(testConfig({ deliveryPollMs: 20 }), withPort.deps);
  try {
    const base = `http://127.0.0.1:${withPort.port()}`;
    await waitFor(() => claimCalls >= 1);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);

    shouldFail = true;
    const callsBeforeFailure = claimCalls;
    await waitFor(() => claimCalls > callsBeforeFailure);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);

    shouldFail = false;
    const callsBeforeRecovery = claimCalls;
    await waitFor(() => claimCalls > callsBeforeRecovery);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  } finally {
    await handle.stop();
  }
});

// --- message decoding + intake + approval card composition --------------

void test('an accepted intake submits the decoded turn, acks the message, and starts an approval watch that renders the injected card', async () => {
  const eventSource = controllableEventSource();
  const submittedTurns: unknown[] = [];
  const repliedTo: string[] = [];
  const sent: Array<{ target: unknown; message: OutgoingMessage }> = [];
  const renderedApprovals: ApprovalView[] = [];

  const deps: RuntimeDeps = {
    createQmClient: () =>
      fakeQm({
        submitTurn: async (turn) => {
          submittedTurns.push(turn);
          return { runId: 'run_test_1', queued: true, steered: false };
        },
        getRun: async () => ({ runId: 'run_test_1', status: 'running' }),
        pendingApproval: async () => ({
          requestId: 'req_test_1',
          status: 'pending',
          command: 'echo hi',
          grantModes: { once: true, session: false, always: false },
        }),
      }),
    createFeishuClient: () =>
      fakeFeishu({
        reply: async (messageId) => {
          repliedTo.push(messageId);
          return { messageId: 'om_test_reply_1' };
        },
        send: async (target, message) => {
          sent.push({ target, message });
          return { messageId: 'om_test_card_1' };
        },
      }),
    createEventSource: () => eventSource.source,
    renderApprovalCard: (approval) => {
      renderedApprovals.push(approval);
      return { kind: 'text', text: `card:${approval.requestId}`, uuid: 'test-uuid' };
    },
  };

  const handle = await runFeishuSurface(testConfig(), deps);
  try {
    await eventSource.emitMessage(messageFixture());

    assert.equal(submittedTurns.length, 1);
    const turn = submittedTurns[0] as { text: string; actor: { externalId: string }; idempotencyKey: string };
    assert.equal(turn.text, 'hello there');
    assert.equal(turn.actor.externalId, 'ou_test_sender_1');
    assert.equal(turn.idempotencyKey, 'feishu:message:om_test_direct_1');
    assert.deepEqual(repliedTo, ['om_test_direct_1']);

    await waitFor(() => sent.length >= 1);
    assert.equal(renderedApprovals.length, 1);
    assert.equal(renderedApprovals[0]?.requestId, 'req_test_1');
    assert.deepEqual(sent[0]?.message, { kind: 'text', text: 'card:req_test_1', uuid: 'test-uuid' });
  } finally {
    await handle.stop();
  }
});

void test('an accepted intake with a failed acknowledgement still starts its approval watch', async () => {
  const eventSource = controllableEventSource();
  let pendingCalls = 0;
  let cardSends = 0;
  const { log, events } = captureLog();
  const deps: RuntimeDeps = {
    createQmClient: () => fakeQm({
      submitTurn: async () => ({ runId: 'run_ack_failed_1', queued: true, steered: false }),
      pendingApproval: async () => {
        pendingCalls += 1;
        return {
          requestId: 'req_ack_failed_1',
          status: 'pending',
          grantModes: { once: true, session: false, always: false },
        };
      },
    }),
    createFeishuClient: () => fakeFeishu({
      reply: async () => { throw new Error('sensitive Feishu failure'); },
      send: async () => {
        cardSends += 1;
        return { messageId: 'om_test_ack_failed_card_1' };
      },
    }),
    createEventSource: () => eventSource.source,
    log,
  };

  const handle = await runFeishuSurface(testConfig(), deps);
  try {
    await eventSource.emitMessage(messageFixture());
    await waitFor(() => cardSends === 1);
    assert.equal(pendingCalls, 1);
    assert.ok(events.some((event) => event.event === 'intake_ack_failed' && event.errorClass === 'Error'));
    assert.equal(JSON.stringify(events).includes('sensitive Feishu failure'), false);
  } finally {
    await handle.stop();
  }
});

void test('a card action after restart reconstructs continuation context, waits for queue acceptance, and re-arms a chained watch', async () => {
  const eventSource = controllableEventSource();
  const continuationTurns: unknown[] = [];
  const queued = deferred<{ runId: string; queued: true; steered: false }>();
  let pendingCalls = 0;
  const sent: OutgoingMessage[] = [];
  const deps: RuntimeDeps = {
    approvalCallbackDeadlineMs: 100,
    createQmClient: () =>
      fakeQm({
        submitTurn: async (turn) => {
          continuationTurns.push(turn);
          return queued.promise;
        },
        getRun: async () => ({ runId: 'run_chained_1', status: 'running' }),
        pendingApproval: async () => {
          pendingCalls += 1;
          return {
            requestId: 'req_chained_2',
            status: 'pending',
            grantModes: { once: true, session: false, always: false },
          };
        },
        getApproval: async () => ({
          requestId: 'req_test_1',
          status: 'pending',
          grantModes: { once: true, session: false, always: false },
          request: {
            actor: { externalId: 'ou_test_operator_1' },
            surface: 'feishu',
            deliveryTarget: 'chat:oc_test_dm_1:message:om_test_1',
            conversation: {
              kind: 'dm',
              threadRef: 'feishu:dm:oc_test_dm_1',
              channelRef: 'oc_test_dm_1',
            },
          },
        }),
      }),
    createFeishuClient: () => fakeFeishu({
      send: async (_target, message) => {
        sent.push(message);
        return { messageId: 'om_test_chained_card_1' };
      },
    }),
    createEventSource: () => eventSource.source,
  };

  const handle = await runFeishuSurface(testConfig(), deps);
  try {
    const callback = eventSource.emitCardAction(cardActionFixture());
    assert.equal(await Promise.race([callback.then(() => 'settled'), delay(10).then(() => 'pending')]), 'pending');
    queued.resolve({ runId: 'run_chained_1', queued: true, steered: false });
    assert.deepEqual(await callback, { toast: { type: 'success', content: 'Approved.' } });

    assert.equal(continuationTurns.length, 1);
    const continuation = continuationTurns[0] as {
      threadRef?: string;
      destination?: string;
      conversation?: { id: string; kind: string };
      approval?: { requestId: string; approved: boolean; scope?: string };
    };
    assert.equal(continuation.threadRef, 'feishu:dm:oc_test_dm_1');
    assert.equal(continuation.destination, 'chat:oc_test_dm_1:message:om_test_1');
    assert.deepEqual(continuation.conversation, { id: 'oc_test_dm_1', kind: 'dm' });
    assert.deepEqual(continuation.approval, { requestId: 'req_test_1', approved: true, scope: 'once' });
    await waitFor(() => sent.length === 1);
    assert.equal(pendingCalls, 1);
  } finally {
    await handle.stop();
  }
});

void test('concurrent timed-out callbacks that later queue the same continuation re-arm exactly one watcher', async () => {
  const eventSource = controllableEventSource();
  const queued = deferred<{ runId: string; queued: true; steered: false }>();
  let sendCalls = 0;
  const deps: RuntimeDeps = {
    approvalCallbackDeadlineMs: 5,
    createQmClient: () => fakeQm({
      submitTurn: async () => queued.promise,
      pendingApproval: async () => ({
        requestId: 'req_late_2', status: 'pending',
        grantModes: { once: true, session: false, always: false },
      }),
      getApproval: async () => ({
        requestId: 'req_test_1', status: 'pending',
        grantModes: { once: true, session: false, always: false },
        request: {
          actor: { externalId: 'ou_test_operator_1' },
          surface: 'feishu',
          deliveryTarget: 'chat:oc_test_dm_1:message:om_test_1',
          conversation: {
            kind: 'dm', threadRef: 'feishu:dm:oc_test_dm_1', channelRef: 'oc_test_dm_1',
          },
        },
      }),
    }),
    createFeishuClient: () => fakeFeishu({
      send: async () => {
        sendCalls += 1;
        return { messageId: 'om_test_late_card_1' };
      },
    }),
    createEventSource: () => eventSource.source,
  };

  const handle = await runFeishuSurface(testConfig(), deps);
  try {
    const responses = await Promise.all([
      eventSource.emitCardAction(cardActionFixture()),
      eventSource.emitCardAction(cardActionFixture()),
    ]);
    assert.deepEqual(responses, [
      { toast: { type: 'error', content: 'This action could not be processed.' } },
      { toast: { type: 'error', content: 'This action could not be processed.' } },
    ]);

    queued.resolve({ runId: 'run_late_shared_1', queued: true, steered: false });
    await waitFor(() => sendCalls === 1);
    assert.equal(sendCalls, 1);
  } finally {
    await handle.stop();
  }
});

void test('runtime deduplicates simultaneous approval watches by authoritative thread and run', async () => {
  const eventSource = controllableEventSource();
  const gate = deferred<{ runId: string; status: 'running' }>();
  let getRunCalls = 0;
  const deps: RuntimeDeps = {
    createQmClient: () => fakeQm({
      submitTurn: async () => ({ runId: 'run_shared_1', queued: true, steered: true }),
      pendingApproval: async () => null,
      getRun: async () => {
        getRunCalls += 1;
        return gate.promise;
      },
    }),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => eventSource.source,
  };

  const handle = await runFeishuSurface(testConfig(), deps);
  try {
    await Promise.all([
      eventSource.emitMessage(messageFixture()),
      eventSource.emitMessage(messageFixture({
        event_id: 'evt_test_direct_2',
        message: {
          message_id: 'om_test_direct_2',
          create_time: '1700000000001',
          chat_id: 'oc_test_dm_1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'follow up' }),
        },
      })),
    ]);
    await waitFor(() => getRunCalls === 1);
    assert.equal(getRunCalls, 1);
  } finally {
    gate.resolve({ runId: 'run_shared_1', status: 'running' });
    await handle.stop();
  }
});

void test('the next same-thread inbound message after restart re-arms the QM-authoritative active run without local state', async () => {
  const eventSource = controllableEventSource();
  let pendingCalls = 0;
  const deps: RuntimeDeps = {
    createQmClient: () => fakeQm({
      submitTurn: async () => ({ runId: 'run_existing_1', queued: true, steered: true }),
      pendingApproval: async () => {
        pendingCalls += 1;
        return {
          requestId: 'req_existing_1', status: 'pending',
          grantModes: { once: true, session: false, always: false },
        };
      },
    }),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => eventSource.source,
  };
  const handle = await runFeishuSurface(testConfig(), deps);
  try {
    await eventSource.emitMessage(messageFixture());
    await waitFor(() => pendingCalls === 1);
    assert.equal(pendingCalls, 1);
  } finally {
    await handle.stop();
  }
});

void test('an unrecognized card action responds with an error toast instead of throwing', async () => {
  const eventSource = controllableEventSource();
  const deps: RuntimeDeps = {
    createQmClient: () => fakeQm(),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => eventSource.source,
  };
  const handle = await runFeishuSurface(testConfig(), deps);
  try {
    const response = await eventSource.emitCardAction(cardActionFixture());
    assert.deepEqual(response, { toast: { type: 'error', content: 'This approval request could not be found.' } });
  } finally {
    await handle.stop();
  }
});

void test('card actions with foreign or missing tenant attribution fail before QM lookup', async () => {
  const eventSource = controllableEventSource();
  let approvalLookups = 0;
  let submissions = 0;
  const deps: RuntimeDeps = {
    createQmClient: () => fakeQm({
      getApproval: async () => {
        approvalLookups += 1;
        return null;
      },
      submitTurn: async () => {
        submissions += 1;
        return { runId: 'run_unexpected_1', queued: true };
      },
    }),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => eventSource.source,
  };
  const handle = await runFeishuSurface(testConfig(), deps);
  try {
    const cases = [
      cardActionFixture({ header: { event_id: 'evt_foreign_tenant', tenant_key: 'tenant_foreign', app_id: 'cli_test_app' } }),
      cardActionFixture({ header: { event_id: 'evt_foreign_app', tenant_key: 'tenant_test_1', app_id: 'cli_foreign' } }),
      cardActionFixture({ event: { operator: { open_id: 'ou_test_operator_1', tenant_key: 'tenant_foreign' }, action: { value: { requestId: 'req_test_1', action: 'allow_once' } } } }),
    ];
    for (const raw of cases) {
      assert.deepEqual(await eventSource.emitCardAction(raw), { toast: { type: 'error', content: 'This action could not be processed.' } });
    }
    assert.equal(approvalLookups, 0);
    assert.equal(submissions, 0);
  } finally {
    await handle.stop();
  }
});

// --- recurring delivery polling -----------------------------------------

void test('deliveries are polled repeatedly on the configured interval', async () => {
  const eventSource = controllableEventSource();
  let claimCalls = 0;
  const deps: RuntimeDeps = {
    createQmClient: () =>
      fakeQm({
        claimDeliveries: async (): Promise<Delivery[]> => {
          claimCalls += 1;
          return [];
        },
      }),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => eventSource.source,
  };
  const handle = await runFeishuSurface(testConfig({ deliveryPollMs: 15 }), deps);
  try {
    await waitFor(() => claimCalls >= 3, 1000);
  } finally {
    await handle.stop();
  }
});

// --- structured logging: redaction + correlation ------------------------

void test('log events flowing through the shared logger redact message content and commands', async () => {
  const eventSource = controllableEventSource();
  const { log, events } = captureLog();
  const deps: RuntimeDeps = {
    createQmClient: () =>
      fakeQm({
        submitTurn: async () => ({ runId: 'run_test_1', queued: true, steered: false }),
        getRun: async () => ({ runId: 'run_test_1', status: 'completed' }),
      }),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => eventSource.source,
    log,
  };
  const handle = await runFeishuSurface(testConfig(), deps);
  try {
    await eventSource.emitMessage(messageFixture());
    await waitFor(() => events.some((event) => event.event === 'intake_outcome'));
    for (const event of events) {
      assert.equal(event.text, undefined);
      assert.equal(event.displayText, undefined);
      assert.equal(event.command, undefined);
    }
  } finally {
    await handle.stop();
  }
});

void test('message decode failures log only the safe decoder reason', async () => {
  const eventSource = controllableEventSource();
  const { log, events } = captureLog();
  const deps: RuntimeDeps = {
    createQmClient: () => fakeQm(),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => eventSource.source,
    log,
  };
  const handle = await runFeishuSurface(testConfig(), deps);
  try {
    await eventSource.emitMessage(messageFixture({
      message: {
        message_id: 'om_secret_message',
        create_time: '1700000000000',
        chat_id: 'oc_secret_chat',
        chat_type: 'p2p',
        message_type: 'file',
        content: JSON.stringify({ file_key: '', file_name: 'secret.txt' }),
      },
    }));

    const failure = events.find((event) => event.event === 'message_decode_failed');
    assert.deepEqual(failure, {
      event: 'message_decode_failed',
      level: 'warn',
      errorClass: 'FeishuDecodeError',
      decodeReason: 'invalid_file_content',
    });
    assert.doesNotMatch(JSON.stringify(events), /secret/);
  } finally {
    await handle.stop();
  }
});

// --- bounded, idempotent shutdown ----------------------------------------

void test('shutdown is idempotent: concurrent stop() calls only stop dependencies once', async () => {
  const eventSource = controllableEventSource();
  let healthStops = 0;
  const { startHealthServer } = await import('../src/health.ts');
  const deps: RuntimeDeps = {
    createQmClient: () => fakeQm(),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => eventSource.source,
    createHealthServer: async (options) => {
      const server = await startHealthServer(options);
      return {
        ...server,
        stop: async () => {
          healthStops += 1;
          await server.stop();
        },
      };
    },
  };
  const handle = await runFeishuSurface(testConfig(), deps);

  const [first, second] = await Promise.all([handle.stop(), handle.stop()]);
  assert.equal(first, undefined);
  assert.equal(second, undefined);
  assert.equal(eventSource.stopCalls, 1);
  assert.equal(healthStops, 1);

  await handle.stop();
  assert.equal(eventSource.stopCalls, 1);
  assert.equal(healthStops, 1);
});

void test('shutdown aborts an approval watch so it cannot resume polling later', async () => {
  const eventSource = controllableEventSource();
  const runGate = deferred<{ runId: string; status: 'running' }>();
  let getRunCalls = 0;
  const deps: RuntimeDeps = {
    createQmClient: () =>
      fakeQm({
        submitTurn: async () => ({ runId: 'run_test_1', queued: true, steered: false }),
        getRun: () => {
          getRunCalls += 1;
          return runGate.promise;
        },
      }),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => eventSource.source,
  };
  const handle = await runFeishuSurface(testConfig({ shutdownTimeoutMs: 50 }), deps);
  await eventSource.emitMessage(messageFixture());
  await waitFor(() => getRunCalls === 1);

  const start = Date.now();
  await handle.stop();
  assert.ok(Date.now() - start < 500);

  runGate.resolve({ runId: 'run_test_1', status: 'running' });
  await delay(30);
  assert.equal(getRunCalls, 1);
});

void test('shutdown uses one global deadline across watchers and delivery draining', async () => {
  const eventSource = controllableEventSource();
  const runGate = deferred<{ runId: string; status: 'running' }>();
  const claimGate = deferred<Delivery[]>();
  let claimCalls = 0;
  const deps: RuntimeDeps = {
    createQmClient: () => fakeQm({
      submitTurn: async () => ({ runId: 'run_test_1', queued: true, steered: false }),
      getRun: () => runGate.promise,
      claimDeliveries: () => {
        claimCalls += 1;
        return claimCalls === 1 ? Promise.resolve([]) : claimGate.promise;
      },
    }),
    createFeishuClient: () => fakeFeishu(),
    createEventSource: () => eventSource.source,
  };
  const handle = await runFeishuSurface(testConfig({ deliveryPollMs: 10, shutdownTimeoutMs: 100 }), deps);
  await eventSource.emitMessage(messageFixture());
  await waitFor(() => claimCalls >= 2);

  const start = Date.now();
  await handle.stop();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 170, `expected one global shutdown deadline, took ${elapsed}ms`);
  runGate.resolve({ runId: 'run_test_1', status: 'running' });
  claimGate.resolve([]);
});
