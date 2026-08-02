import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyedQueue } from '../../src/surface/keyed-queue.js';

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

test('same-key tasks run strictly in submission order', async () => {
  const queue = new KeyedQueue();
  const order: string[] = [];
  const gate = deferred<void>();

  const first = queue.run('dest:oc_test_1', async () => {
    order.push('start-1');
    await gate.promise;
    order.push('end-1');
  });
  const second = queue.run('dest:oc_test_1', async () => {
    order.push('start-2');
  });

  await delay(10);
  assert.deepEqual(order, ['start-1']);

  gate.resolve();
  await first;
  await second;
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2']);
});

test('different-key tasks progress independently', async () => {
  const queue = new KeyedQueue();
  const order: string[] = [];
  const gateA = deferred<void>();

  const taskA = queue.run('dest:oc_test_1', async () => {
    order.push('start-a');
    await gateA.promise;
    order.push('end-a');
  });
  const taskB = queue.run('dest:oc_test_2', async () => {
    order.push('start-b');
    order.push('end-b');
  });

  await taskB;
  assert.deepEqual(order, ['start-a', 'start-b', 'end-b']);

  gateA.resolve();
  await taskA;
  assert.deepEqual(order, ['start-a', 'start-b', 'end-b', 'end-a']);
});

test('a rejected task does not block later tasks for the same key', async () => {
  const queue = new KeyedQueue();
  const order: string[] = [];

  const first = queue.run('dest:oc_test_1', async () => {
    order.push('task-1');
    throw new Error('boom');
  });
  const second = queue.run('dest:oc_test_1', async () => {
    order.push('task-2');
  });

  await assert.rejects(first, /boom/);
  await second;
  assert.deepEqual(order, ['task-1', 'task-2']);
});

test('activeCount tracks in-flight work across all keys', async () => {
  const queue = new KeyedQueue();
  const gate = deferred<void>();
  assert.equal(queue.activeCount, 0);

  const taskA = queue.run('dest:oc_test_1', async () => {
    await gate.promise;
  });
  const taskB = queue.run('dest:oc_test_2', async () => {
    await gate.promise;
  });
  assert.equal(queue.activeCount, 2);

  gate.resolve();
  await Promise.all([taskA, taskB]);
  assert.equal(queue.activeCount, 0);
});

test('drain resolves true immediately when the queue is already idle', async () => {
  const queue = new KeyedQueue();
  assert.equal(await queue.drain(1_000), true);
});

test('drain resolves true once all in-flight tasks settle', async () => {
  const queue = new KeyedQueue();
  const gate = deferred<void>();
  const task = queue.run('dest:oc_test_1', async () => {
    await gate.promise;
  });

  const drained = queue.drain(1_000);
  gate.resolve();
  await task;
  assert.equal(await drained, true);
});

test('drain resolves false when the timeout elapses before tasks settle', async () => {
  const queue = new KeyedQueue();
  const gate = deferred<void>();
  const task = queue.run('dest:oc_test_1', async () => {
    await gate.promise;
  });

  assert.equal(await queue.drain(20), false);

  gate.resolve();
  await task;
});
