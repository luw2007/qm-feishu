import assert from 'node:assert/strict';
import test from 'node:test';

import { FeishuPermanentError } from '../../src/feishu/client.js';
import type { FeishuDirectoryApiClient } from '../../src/feishu/directory.js';
import { fetchFeishuDirectory } from '../../src/feishu/directory.js';

void test('directory fetch fails when chat listing returns a business error', async () => {
  const client = {
    im: {
      v1: {
        chat: { list: async () => ({ code: 999_001 }) },
        chatMembers: { get: async () => ({ code: 0, data: { items: [] } }) },
      },
    },
  } satisfies FeishuDirectoryApiClient;

  await assert.rejects(fetchFeishuDirectory(client), FeishuPermanentError);
});

void test('directory fetch fails when member pagination returns a business error', async () => {
  const client = {
    im: {
      v1: {
        chat: { list: async () => ({ code: 0, data: { items: [{ chat_id: 'oc_test_group_1' }] } }) },
        chatMembers: { get: async () => ({ code: 999_002 }) },
      },
    },
  } satisfies FeishuDirectoryApiClient;

  await assert.rejects(fetchFeishuDirectory(client), FeishuPermanentError);
});
