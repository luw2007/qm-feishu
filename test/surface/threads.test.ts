import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDeliveryTarget,
  parseThreadRef,
  renderDeliveryTarget,
  renderThreadRef,
  resolveThreadRef,
  ThreadGrammarError,
} from '../../src/surface/threads.js';

test('renderThreadRef/parseThreadRef: dm round-trips as feishu:dm:<chat_id>', () => {
  const ref = renderThreadRef({ kind: 'dm', chatId: 'oc_test_dm_1' });
  assert.equal(ref, 'feishu:dm:oc_test_dm_1');
  assert.deepEqual(parseThreadRef(ref), { kind: 'dm', chatId: 'oc_test_dm_1' });
});

test('renderThreadRef/parseThreadRef: chat round-trips as feishu:chat:<chat_id>:message:<root_message_id>', () => {
  const ref = renderThreadRef({ kind: 'chat', chatId: 'oc_test_group_1', rootMessageId: 'om_test_root_1' });
  assert.equal(ref, 'feishu:chat:oc_test_group_1:message:om_test_root_1');
  assert.deepEqual(parseThreadRef(ref), { kind: 'chat', chatId: 'oc_test_group_1', rootMessageId: 'om_test_root_1' });
});

test('parseThreadRef: rejects an unknown prefix', () => {
  assert.throws(() => parseThreadRef('slack:dm:C1'), ThreadGrammarError);
  assert.throws(() => parseThreadRef('feishu:channel:oc_test_1'), ThreadGrammarError);
});

test('parseThreadRef: rejects empty identifiers', () => {
  assert.throws(() => parseThreadRef('feishu:dm:'), ThreadGrammarError);
  assert.throws(() => parseThreadRef('feishu:chat::message:om_test_1'), ThreadGrammarError);
  assert.throws(() => parseThreadRef('feishu:chat:oc_test_1:message:'), ThreadGrammarError);
});

test('parseThreadRef: rejects extra segments', () => {
  assert.throws(() => parseThreadRef('feishu:dm:oc_test_1:extra'), ThreadGrammarError);
  assert.throws(() => parseThreadRef('feishu:chat:oc_test_1:message:om_test_1:extra'), ThreadGrammarError);
});

test('renderThreadRef: rejects empty identifiers before rendering', () => {
  assert.throws(() => renderThreadRef({ kind: 'dm', chatId: '' }), ThreadGrammarError);
  assert.throws(() => renderThreadRef({ kind: 'chat', chatId: 'oc_test_1', rootMessageId: '' }), ThreadGrammarError);
});

test('renderDeliveryTarget/parseDeliveryTarget: chat round-trips as chat:<chat_id>:message:<root_message_id>', () => {
  const target = renderDeliveryTarget({ kind: 'chat', chatId: 'oc_test_1', rootMessageId: 'om_test_1' });
  assert.equal(target, 'chat:oc_test_1:message:om_test_1');
  assert.deepEqual(parseDeliveryTarget(target), { kind: 'chat', chatId: 'oc_test_1', rootMessageId: 'om_test_1' });
});

test('renderDeliveryTarget/parseDeliveryTarget: user round-trips as user:<open_id>', () => {
  const target = renderDeliveryTarget({ kind: 'user', openId: 'ou_test_1' });
  assert.equal(target, 'user:ou_test_1');
  assert.deepEqual(parseDeliveryTarget(target), { kind: 'user', openId: 'ou_test_1' });
});

test('parseDeliveryTarget: rejects unknown prefixes, empty identifiers, and extra segments', () => {
  assert.throws(() => parseDeliveryTarget('channel:oc_test_1'), ThreadGrammarError);
  assert.throws(() => parseDeliveryTarget('user:'), ThreadGrammarError);
  assert.throws(() => parseDeliveryTarget('chat:oc_test_1:message:'), ThreadGrammarError);
  assert.throws(() => parseDeliveryTarget('chat:oc_test_1:message:om_test_1:extra'), ThreadGrammarError);
});

test('resolveThreadRef: direct messages map to the dm chat', () => {
  assert.deepEqual(
    resolveThreadRef({ chatType: 'p2p', chatId: 'oc_test_dm_1', messageId: 'om_test_1' }),
    { kind: 'dm', chatId: 'oc_test_dm_1' },
  );
});

test('resolveThreadRef: non-topic group mentions root at the triggering message_id', () => {
  assert.deepEqual(
    resolveThreadRef({ chatType: 'group', chatId: 'oc_test_group_1', messageId: 'om_test_trigger_1' }),
    { kind: 'chat', chatId: 'oc_test_group_1', rootMessageId: 'om_test_trigger_1' },
  );
});

test('resolveThreadRef: topic replies root at root_id', () => {
  assert.deepEqual(
    resolveThreadRef({
      chatType: 'group',
      chatId: 'oc_test_group_1',
      messageId: 'om_test_followup_1',
      rootId: 'om_test_root_1',
    }),
    { kind: 'chat', chatId: 'oc_test_group_1', rootMessageId: 'om_test_root_1' },
  );
});
