import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { FeishuApiClient } from '../../src/feishu/client.js';
import {
  FeishuPermanentError,
  FeishuRateLimitedError,
  FeishuSdkClient,
  FeishuTransientError,
  FeishuUnavailableError,
} from '../../src/feishu/client.js';
import { decodeMessageReceipt, decodeReceivedMessage, FeishuDecodeError, outgoingPayload } from '../../src/feishu/messages.js';

async function fixture(name: string): Promise<unknown> {
  const raw = await readFile(new URL(`../fixtures/feishu/${name}`, import.meta.url), 'utf8');
  return JSON.parse(raw);
}

test('decodeReceivedMessage: direct p2p text', async () => {
  const message = decodeReceivedMessage(await fixture('receive-direct-text.json'));
  assert.deepEqual(message, {
    eventId: 'evt_test_direct_1',
    tenantKey: 'tenant_test_1',
    messageId: 'om_test_direct_1',
    chatId: 'oc_test_dm_1',
    chatType: 'p2p',
    messageType: 'text',
    senderOpenId: 'ou_test_sender_1',
    senderType: 'user',
    createTime: 1_700_000_000_000,
    text: 'hello there',
    mentions: [],
  });
});

test('decodeReceivedMessage: group text with mentions', async () => {
  const message = decodeReceivedMessage(await fixture('receive-group-text.json'));
  assert.equal(message.chatType, 'group');
  assert.equal(message.text, '@_user_1 please review');
  assert.deepEqual(message.mentions, ['ou_test_mentioned_1']);
});

test('decodeReceivedMessage: topic reply carries rootId and threadId', async () => {
  const message = decodeReceivedMessage(await fixture('receive-topic-reply.json'));
  assert.equal(message.rootId, 'om_test_topic_root_1');
  assert.equal(message.threadId, 'omt_test_thread_1');
  assert.equal(message.text, 'following up in thread');
});

test('decodeReceivedMessage: post flattens title and paragraphs', async () => {
  const message = decodeReceivedMessage(await fixture('receive-post.json'));
  assert.equal(message.messageType, 'post');
  assert.equal(message.text, '发布通知\n部署已完成 查看详情\n第二行');
});

test('decodeReceivedMessage: image carries resource key', async () => {
  const message = decodeReceivedMessage(await fixture('receive-image.json'));
  assert.equal(message.messageType, 'image');
  assert.deepEqual(message.resource, { key: 'img_test_key_1' });
});

test('decodeReceivedMessage: file carries resource key and filename', async () => {
  const message = decodeReceivedMessage(await fixture('receive-file.json'));
  assert.equal(message.messageType, 'file');
  assert.deepEqual(message.resource, { key: 'file_test_key_1', filename: 'report.pdf' });
});

test('decodeReceivedMessage: rejects non-object input', () => {
  assert.throws(() => decodeReceivedMessage(null), FeishuDecodeError);
  assert.throws(() => decodeReceivedMessage('nope'), FeishuDecodeError);
});

test('decodeReceivedMessage: rejects missing sender open_id', () => {
  assert.throws(
    () =>
      decodeReceivedMessage({
        event_id: 'evt_1',
        sender: { sender_id: {}, sender_type: 'user' },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'text',
          create_time: '1',
          content: '{"text":"hi"}',
        },
      }),
    FeishuDecodeError,
  );
});

test('decodeReceivedMessage: rejects invalid chat_type', () => {
  assert.throws(
    () =>
      decodeReceivedMessage({
        event_id: 'evt_1',
        sender: { sender_id: { open_id: 'ou_test_1' }, sender_type: 'user' },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_1',
          chat_type: 'channel',
          message_type: 'text',
          create_time: '1',
          content: '{"text":"hi"}',
        },
      }),
    FeishuDecodeError,
  );
});

test('decodeReceivedMessage: rejects unsupported message_type', () => {
  assert.throws(
    () =>
      decodeReceivedMessage({
        event_id: 'evt_1',
        sender: { sender_id: { open_id: 'ou_test_1' }, sender_type: 'user' },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'audio',
          create_time: '1',
          content: '{}',
        },
      }),
    FeishuDecodeError,
  );
});

test('decodeReceivedMessage: rejects content that is not JSON', () => {
  assert.throws(
    () =>
      decodeReceivedMessage({
        event_id: 'evt_1',
        sender: { sender_id: { open_id: 'ou_test_1' }, sender_type: 'user' },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'text',
          create_time: '1',
          content: 'not-json',
        },
      }),
    FeishuDecodeError,
  );
});

test('outgoingPayload: builds text/card/image/file payloads', () => {
  assert.deepEqual(outgoingPayload({ kind: 'text', text: 'hi', uuid: 'u1' }), {
    msgType: 'text',
    content: JSON.stringify({ text: 'hi' }),
  });
  assert.deepEqual(outgoingPayload({ kind: 'card', card: { foo: 'bar' }, uuid: 'u2' }), {
    msgType: 'interactive',
    content: JSON.stringify({ foo: 'bar' }),
  });
  assert.deepEqual(outgoingPayload({ kind: 'image', imageKey: 'img_test_1', uuid: 'u3' }), {
    msgType: 'image',
    content: JSON.stringify({ image_key: 'img_test_1' }),
  });
  assert.deepEqual(outgoingPayload({ kind: 'file', fileKey: 'file_test_1', uuid: 'u4' }), {
    msgType: 'file',
    content: JSON.stringify({ file_key: 'file_test_1' }),
  });
});

test('decodeMessageReceipt: extracts message and chat ids', () => {
  assert.deepEqual(decodeMessageReceipt({ data: { message_id: 'om_test_1', chat_id: 'oc_test_1' } }), {
    messageId: 'om_test_1',
    chatId: 'oc_test_1',
  });
  assert.deepEqual(decodeMessageReceipt({ data: { message_id: 'om_test_1' } }), { messageId: 'om_test_1' });
});

test('decodeMessageReceipt: rejects missing message_id', () => {
  assert.throws(() => decodeMessageReceipt({ data: {} }), FeishuDecodeError);
  assert.throws(() => decodeMessageReceipt({}), FeishuDecodeError);
});

function fakeApiClient(overrides: Partial<FeishuApiClient['im']['v1']>): FeishuApiClient {
  return {
    im: {
      v1: {
        message: {
          reply: async () => ({ data: { message_id: 'om_test_x' } }),
          create: async () => ({ data: { message_id: 'om_test_x' } }),
          patch: async () => ({ code: 0 }),
        },
        image: { create: async () => ({ image_key: 'img_test_x' }) },
        file: { create: async () => ({ file_key: 'file_test_x' }) },
        messageResource: { get: async () => ({ getReadableStream: () => { throw new Error('unused'); } }) },
        chat: { list: async () => ({ code: 0 }) },
        ...overrides,
      },
    },
  } as FeishuApiClient;
}

test('FeishuSdkClient.reply: posts through message.reply and decodes the receipt', async () => {
  let captured: unknown;
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: fakeApiClient({
      message: {
        reply: async (payload) => {
          captured = payload;
          return { data: { message_id: 'om_test_reply_1', chat_id: 'oc_test_1' } };
        },
        create: async () => ({ data: { message_id: 'om_test_x' } }),
        patch: async () => ({ code: 0 }),
      },
    }),
  });

  const receipt = await client.reply('om_test_parent_1', { kind: 'text', text: 'hi', uuid: 'uuid_test_1' });
  assert.deepEqual(receipt, { messageId: 'om_test_reply_1', chatId: 'oc_test_1' });
  assert.deepEqual(captured, {
    data: { content: JSON.stringify({ text: 'hi' }), msg_type: 'text', reply_in_thread: true, uuid: 'uuid_test_1' },
    path: { message_id: 'om_test_parent_1' },
  });
});

test('FeishuSdkClient.send: reply target delegates to message.reply', async () => {
  let replyCalled = false;
  let createCalled = false;
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: fakeApiClient({
      message: {
        reply: async () => {
          replyCalled = true;
          return { data: { message_id: 'om_test_reply_2' } };
        },
        create: async () => {
          createCalled = true;
          return { data: { message_id: 'om_test_x' } };
        },
        patch: async () => ({ code: 0 }),
      },
    }),
  });

  await client.send({ kind: 'reply', chatId: 'oc_test_1', messageId: 'om_test_parent_2' }, { kind: 'text', text: 'hi', uuid: 'u1' });
  assert.equal(replyCalled, true);
  assert.equal(createCalled, false);
});

test('FeishuSdkClient.send: user target posts through message.create with receive_id_type open_id', async () => {
  let captured: unknown;
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: fakeApiClient({
      message: {
        reply: async () => ({ data: { message_id: 'om_test_x' } }),
        create: async (payload) => {
          captured = payload;
          return { data: { message_id: 'om_test_created_1' } };
        },
        patch: async () => ({ code: 0 }),
      },
    }),
  });

  const receipt = await client.send({ kind: 'user', openId: 'ou_test_recipient_1' }, { kind: 'text', text: 'hi', uuid: 'uuid_test_2' });
  assert.deepEqual(receipt, { messageId: 'om_test_created_1' });
  assert.deepEqual(captured, {
    data: { receive_id: 'ou_test_recipient_1', msg_type: 'text', content: JSON.stringify({ text: 'hi' }), uuid: 'uuid_test_2' },
    params: { receive_id_type: 'open_id' },
  });
});

test('FeishuSdkClient.update: card payloads go through message.patch', async () => {
  let captured: unknown;
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: fakeApiClient({
      message: {
        reply: async () => ({ data: { message_id: 'om_test_x' } }),
        create: async () => ({ data: { message_id: 'om_test_x' } }),
        patch: async (payload) => {
          captured = payload;
          return { code: 0 };
        },
      },
    }),
  });

  await client.update('om_test_card_1', { kind: 'card', card: { header: {} }, uuid: 'uuid_test_3' });
  assert.deepEqual(captured, {
    data: { content: JSON.stringify({ header: {} }) },
    path: { message_id: 'om_test_card_1' },
  });
});

test('FeishuSdkClient.update: rejects non-card payloads since Feishu has no plain-message update endpoint', async () => {
  const client = new FeishuSdkClient({ appId: 'cli_test_1', appSecret: 'secret_test_1', client: fakeApiClient({}) });
  await assert.rejects(() => client.update('om_test_1', { kind: 'text', text: 'hi', uuid: 'u1' }), TypeError);
});

function rejectingClient(error: unknown): FeishuApiClient {
  return fakeApiClient({
    message: {
      reply: async () => {
        throw error;
      },
      create: async () => ({ data: { message_id: 'om_test_x' } }),
      patch: async () => ({ code: 0 }),
    },
  });
}

test('FeishuSdkClient: classifies a 429 response as FeishuRateLimitedError with retry-after metadata', async () => {
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: rejectingClient({ response: { status: 429, data: { code: 99991400 }, headers: { 'retry-after': '2' } } }),
  });

  await assert.rejects(
    () => client.reply('om_test_1', { kind: 'text', text: 'hi', uuid: 'u1' }),
    (error: unknown) => {
      assert.ok(error instanceof FeishuRateLimitedError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 2_000);
      return true;
    },
  );
});

test('FeishuSdkClient: classifies a 5xx response as FeishuTransientError', async () => {
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: rejectingClient({ response: { status: 503, data: {} } }),
  });

  await assert.rejects(
    () => client.reply('om_test_1', { kind: 'text', text: 'hi', uuid: 'u1' }),
    (error: unknown) => {
      assert.ok(error instanceof FeishuTransientError);
      assert.equal(error.status, 503);
      return true;
    },
  );
});

test('FeishuSdkClient: classifies a 4xx response (non-429) as FeishuPermanentError', async () => {
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: rejectingClient({ response: { status: 403, data: { code: 99991672 } } }),
  });

  await assert.rejects(
    () => client.reply('om_test_1', { kind: 'text', text: 'hi', uuid: 'u1' }),
    (error: unknown) => {
      assert.ok(error instanceof FeishuPermanentError);
      assert.equal(error.status, 403);
      assert.equal(error.feishuCode, 99991672);
      return true;
    },
  );
});

test('FeishuSdkClient: classifies a response-less network failure as FeishuUnavailableError', async () => {
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: rejectingClient(new Error('ECONNRESET')),
  });

  await assert.rejects(() => client.reply('om_test_1', { kind: 'text', text: 'hi', uuid: 'u1' }), FeishuUnavailableError);
});

test('FeishuSdkClient: raises a permanent error when a 2xx response carries a non-zero business code', async () => {
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: fakeApiClient({
      message: {
        reply: async () => ({ code: 99991663, msg: 'param error' }),
        create: async () => ({ data: { message_id: 'om_test_x' } }),
        patch: async () => ({ code: 0 }),
      },
    }),
  });

  await assert.rejects(
    () => client.reply('om_test_1', { kind: 'text', text: 'hi', uuid: 'u1' }),
    (error: unknown) => {
      assert.ok(error instanceof FeishuPermanentError);
      assert.equal(error.feishuCode, 99991663);
      return true;
    },
  );
});
