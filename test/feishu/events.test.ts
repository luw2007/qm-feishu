import assert from 'node:assert/strict';
import test from 'node:test';

import { FeishuSdkEventSource } from '../../src/feishu/events.js';

test('FeishuSdkEventSource.start: registers im.message.receive_v1 and forwards the raw payload untouched', async () => {
  const received: unknown[] = [];
  let registeredHandles: Record<string, (data: unknown) => unknown> | undefined;
  let startedWith: unknown;

  const source = new FeishuSdkEventSource({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    createEventDispatcher: () => ({
      register: (handles) => {
        registeredHandles = handles as Record<string, (data: unknown) => unknown>;
        return undefined;
      },
    }),
    createWsClient: () => ({
      start: async (params) => {
        startedWith = params;
      },
      close: () => {},
    }),
  });

  await source.start({
    onMessage: async (event) => {
      received.push(event);
    },
    onCardAction: async () => undefined,
  });

  assert.ok(registeredHandles);
  await registeredHandles!['im.message.receive_v1']!({ event_id: 'evt_test_1' });
  assert.deepEqual(received, [{ event_id: 'evt_test_1' }]);
  assert.ok(startedWith);
});

test('FeishuSdkEventSource.start: registers card actions on the WebSocket dispatcher', async () => {
  let registeredHandles: Record<string, (data: unknown) => unknown> | undefined;
  const source = new FeishuSdkEventSource({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    createEventDispatcher: () => ({
      register: (handles) => {
        registeredHandles = handles;
        return undefined;
      },
    }),
    createWsClient: () => ({ start: async () => {}, close: () => {} }),
  });

  await source.start({
    onMessage: async () => {},
    onCardAction: async (event) => {
      assert.ok(typeof event === 'object' && event !== null && 'event_id' in event);
      assert.equal(typeof event.event_id, 'string');
      return { toast: { type: 'success' }, echoedEventId: event.event_id };
    },
  });

  assert.ok(registeredHandles);
  const cardHandler = registeredHandles['card.action.trigger'];
  assert.ok(cardHandler);
  assert.deepEqual(await cardHandler({ event_id: 'evt_test_card_1' }), {
    toast: { type: 'success' },
    echoedEventId: 'evt_test_card_1',
  });
});

test('FeishuSdkEventSource.stop: closes the underlying ws client', async () => {
  let closedWith: unknown;

  const source = new FeishuSdkEventSource({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    createEventDispatcher: () => ({ register: () => undefined }),
    createWsClient: () => ({
      start: async () => {},
      close: (params) => {
        closedWith = params;
      },
    }),
  });

  await source.start({ onMessage: async () => {}, onCardAction: async () => undefined });
  await source.stop();
  assert.deepEqual(closedWith, { force: true });
});


test('FeishuSdkEventSource.start: optionally waits for a confirmed connection', async () => {
  let ready: (() => void) | undefined;
  const source = new FeishuSdkEventSource({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    awaitReady: true,
    createEventDispatcher: () => ({ register: () => undefined }),
    createWsClient: (options) => {
      ready = () => options.onReady?.();
      return { start: async () => undefined, close: () => undefined };
    },
  });

  let settled = false;
  const started = source.start({ onMessage: async () => undefined, onCardAction: async () => undefined }).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.ok(ready !== undefined);
  ready();
  await started;
  assert.equal(settled, true);
});

test('FeishuSdkEventSource.start: rejects a confirmed connection error without leaking SDK details', async () => {
  const source = new FeishuSdkEventSource({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    awaitReady: true,
    createEventDispatcher: () => ({ register: () => undefined }),
    createWsClient: (options) => ({
      start: async () => {
        assert.ok(options.onError !== undefined);
        options.onError(new Error('secret_test_1'));
      },
      close: () => undefined,
    }),
  });

  await assert.rejects(
    source.start({ onMessage: async () => undefined, onCardAction: async () => undefined }),
    /Feishu long connection failed/,
  );
});

test('FeishuSdkEventSource: rejects a missing appId or appSecret', () => {
  assert.throws(() => new FeishuSdkEventSource({ appId: '', appSecret: 'secret_test_1' }), TypeError);
  assert.throws(() => new FeishuSdkEventSource({ appId: 'cli_test_1', appSecret: '' }), TypeError);
});
