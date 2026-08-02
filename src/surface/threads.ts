import type { NormalizedFeishuMessage } from '../types.js';

export type ThreadRef = { kind: 'dm'; chatId: string } | { kind: 'chat'; chatId: string; rootMessageId: string };

export type DeliveryTarget =
  | { kind: 'chat'; chatId: string; rootMessageId: string }
  | { kind: 'user'; openId: string };

export class ThreadGrammarError extends Error {
  constructor(reason: string) {
    super(`Feishu thread/target grammar violation: ${reason}`);
    this.name = 'ThreadGrammarError';
  }
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function renderThreadRef(ref: ThreadRef): string {
  if (ref.kind === 'dm') {
    if (!nonEmpty(ref.chatId)) throw new ThreadGrammarError('empty_chat_id');
    return `feishu:dm:${ref.chatId}`;
  }
  if (!nonEmpty(ref.chatId) || !nonEmpty(ref.rootMessageId)) throw new ThreadGrammarError('empty_identifier');
  return `feishu:chat:${ref.chatId}:message:${ref.rootMessageId}`;
}

export function parseThreadRef(raw: string): ThreadRef {
  const parts = raw.split(':');
  if (parts[0] !== 'feishu') throw new ThreadGrammarError('unknown_prefix');
  if (parts[1] === 'dm') {
    if (parts.length !== 3) throw new ThreadGrammarError('malformed_dm');
    const chatId = parts[2];
    if (!nonEmpty(chatId)) throw new ThreadGrammarError('empty_chat_id');
    return { kind: 'dm', chatId };
  }
  if (parts[1] === 'chat') {
    if (parts.length !== 5 || parts[3] !== 'message') throw new ThreadGrammarError('malformed_chat');
    const chatId = parts[2];
    const rootMessageId = parts[4];
    if (!nonEmpty(chatId) || !nonEmpty(rootMessageId)) throw new ThreadGrammarError('empty_identifier');
    return { kind: 'chat', chatId, rootMessageId };
  }
  throw new ThreadGrammarError('unknown_prefix');
}

export function renderDeliveryTarget(target: DeliveryTarget): string {
  if (target.kind === 'user') {
    if (!nonEmpty(target.openId)) throw new ThreadGrammarError('empty_open_id');
    return `user:${target.openId}`;
  }
  if (!nonEmpty(target.chatId) || !nonEmpty(target.rootMessageId)) throw new ThreadGrammarError('empty_identifier');
  return `chat:${target.chatId}:message:${target.rootMessageId}`;
}

export function parseDeliveryTarget(raw: string): DeliveryTarget {
  const parts = raw.split(':');
  if (parts[0] === 'user') {
    if (parts.length !== 2) throw new ThreadGrammarError('malformed_user');
    const openId = parts[1];
    if (!nonEmpty(openId)) throw new ThreadGrammarError('empty_open_id');
    return { kind: 'user', openId };
  }
  if (parts[0] === 'chat') {
    if (parts.length !== 4 || parts[2] !== 'message') throw new ThreadGrammarError('malformed_chat_target');
    const chatId = parts[1];
    const rootMessageId = parts[3];
    if (!nonEmpty(chatId) || !nonEmpty(rootMessageId)) throw new ThreadGrammarError('empty_identifier');
    return { kind: 'chat', chatId, rootMessageId };
  }
  throw new ThreadGrammarError('unknown_prefix');
}

export function resolveThreadRef(
  message: Pick<NormalizedFeishuMessage, 'chatType' | 'chatId' | 'messageId' | 'rootId'>,
): ThreadRef {
  if (message.chatType === 'p2p') return { kind: 'dm', chatId: message.chatId };
  return { kind: 'chat', chatId: message.chatId, rootMessageId: message.rootId ?? message.messageId };
}
