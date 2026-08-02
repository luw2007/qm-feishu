import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import type { FeishuApiClient } from '../../src/feishu/client.js';
import { FeishuContractError, FeishuSdkClient } from '../../src/feishu/client.js';
import {
  assertUploadable,
  FEISHU_MAX_FILE_UPLOAD_BYTES,
  FEISHU_MAX_IMAGE_UPLOAD_BYTES,
  feishuFileType,
  FeishuUploadRejectedError,
  toWebStream,
} from '../../src/feishu/files.js';

test('assertUploadable: rejects empty files', () => {
  assert.throws(
    () => assertUploadable({ bytes: new Uint8Array(0), filename: 'a.txt', mediaType: 'text/plain', kind: 'file' }),
    FeishuUploadRejectedError,
  );
});

test('assertUploadable: rejects files over the 30 MB ceiling', () => {
  assert.throws(
    () =>
      assertUploadable({
        bytes: new Uint8Array(FEISHU_MAX_FILE_UPLOAD_BYTES + 1),
        filename: 'a.bin',
        mediaType: 'application/octet-stream',
        kind: 'file',
      }),
    FeishuUploadRejectedError,
  );
});

test('assertUploadable: rejects images over the 10 MB ceiling', () => {
  assert.throws(
    () =>
      assertUploadable({
        bytes: new Uint8Array(FEISHU_MAX_IMAGE_UPLOAD_BYTES + 1),
        filename: 'a.png',
        mediaType: 'image/png',
        kind: 'image',
      }),
    FeishuUploadRejectedError,
  );
});

test('assertUploadable: accepts a file at the boundary', () => {
  assertUploadable({
    bytes: new Uint8Array(FEISHU_MAX_FILE_UPLOAD_BYTES),
    filename: 'a.bin',
    mediaType: 'application/octet-stream',
    kind: 'file',
  });
});

test('feishuFileType: maps known media types', () => {
  assert.equal(feishuFileType('application/pdf'), 'pdf');
  assert.equal(feishuFileType('video/mp4'), 'mp4');
  assert.equal(feishuFileType('audio/mpeg'), 'opus');
  assert.equal(feishuFileType('application/msword'), 'doc');
  assert.equal(feishuFileType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'doc');
  assert.equal(feishuFileType('application/vnd.ms-excel'), 'xls');
  assert.equal(feishuFileType('application/vnd.ms-powerpoint'), 'ppt');
  assert.equal(feishuFileType('application/octet-stream'), 'stream');
});

test('toWebStream: wraps a Readable and preserves bytes', async () => {
  const readable = Readable.from([Buffer.from('hello')]);
  const web = toWebStream(readable);
  const reader = web.getReader();
  const { value } = await reader.read();
  assert.deepEqual(Buffer.from(value as Uint8Array).toString(), 'hello');
});

function fakeClient(overrides: Partial<FeishuApiClient['im']['v1']>): FeishuApiClient {
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
        messageResource: { get: async () => ({ getReadableStream: () => Readable.from([Buffer.from('bytes')]) }) },
        chat: { list: async () => ({ code: 0 }) },
        ...overrides,
      },
    },
  } as FeishuApiClient;
}

test('FeishuSdkClient.download: wraps the message resource stream as a web ReadableStream', async () => {
  let captured: unknown;
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: fakeClient({
      messageResource: {
        get: async (payload) => {
          captured = payload;
          return { getReadableStream: () => Readable.from([Buffer.from('file-bytes')]) };
        },
      },
    }),
  });

  const stream = await client.download({ messageId: 'om_test_1', resourceKey: 'file_test_key_1', kind: 'file' });
  const reader = stream.getReader();
  const { value } = await reader.read();
  assert.equal(Buffer.from(value as Uint8Array).toString(), 'file-bytes');
  assert.deepEqual(captured, { params: { type: 'file' }, path: { message_id: 'om_test_1', file_key: 'file_test_key_1' } });
});

test('FeishuSdkClient.upload: image goes through image.create and returns the image key', async () => {
  let captured: unknown;
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: fakeClient({
      image: {
        create: async (payload) => {
          captured = payload;
          return { image_key: 'img_test_uploaded_1' };
        },
      },
    }),
  });

  const key = await client.upload({ bytes: new Uint8Array([1, 2, 3]), filename: 'a.png', mediaType: 'image/png', kind: 'image' });
  assert.deepEqual(key, { kind: 'image', key: 'img_test_uploaded_1' });
  assert.equal((captured as { data: { image_type: string } }).data.image_type, 'message');
});

test('FeishuSdkClient.upload: file goes through file.create with the mapped file_type', async () => {
  let captured: unknown;
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: fakeClient({
      file: {
        create: async (payload) => {
          captured = payload;
          return { file_key: 'file_test_uploaded_1' };
        },
      },
    }),
  });

  const key = await client.upload({
    bytes: new Uint8Array([1, 2, 3]),
    filename: 'report.pdf',
    mediaType: 'application/pdf',
    kind: 'file',
  });
  assert.deepEqual(key, { kind: 'file', key: 'file_test_uploaded_1' });
  assert.deepEqual((captured as { data: { file_type: string; file_name: string } }).data, {
    file_type: 'pdf',
    file_name: 'report.pdf',
    file: Buffer.from([1, 2, 3]),
  });
});

test('FeishuSdkClient.upload: rejects an empty file before calling the SDK', async () => {
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: fakeClient({
      file: {
        create: async () => {
          throw new Error('should not be called');
        },
      },
    }),
  });

  await assert.rejects(
    () => client.upload({ bytes: new Uint8Array(0), filename: 'a.txt', mediaType: 'text/plain', kind: 'file' }),
    FeishuUploadRejectedError,
  );
});

test('FeishuSdkClient.upload: rejects a file over the 30 MB ceiling before calling the SDK', async () => {
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: fakeClient({
      file: {
        create: async () => {
          throw new Error('should not be called');
        },
      },
    }),
  });

  await assert.rejects(
    () =>
      client.upload({
        bytes: new Uint8Array(FEISHU_MAX_FILE_UPLOAD_BYTES + 1),
        filename: 'a.bin',
        mediaType: 'application/octet-stream',
        kind: 'file',
      }),
    FeishuUploadRejectedError,
  );
});

test('FeishuSdkClient.upload: raises a contract error when the SDK silently returns no key', async () => {
  const client = new FeishuSdkClient({
    appId: 'cli_test_1',
    appSecret: 'secret_test_1',
    client: fakeClient({ image: { create: async () => null } }),
  });

  await assert.rejects(
    () => client.upload({ bytes: new Uint8Array([1]), filename: 'a.png', mediaType: 'image/png', kind: 'image' }),
    FeishuContractError,
  );
});
