import type { MessageReceipt, NormalizedFeishuMessage, OutgoingMessage } from '../types.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export type FeishuDecodeReason =
  | 'content_not_json'
  | 'invalid_post_content'
  | 'invalid_content'
  | 'invalid_text_content'
  | 'invalid_image_content'
  | 'invalid_file_content'
  | 'not_an_object'
  | 'missing_event_id'
  | 'missing_sender'
  | 'missing_sender_open_id'
  | 'missing_sender_type'
  | 'missing_message'
  | 'missing_message_id'
  | 'missing_chat_id'
  | 'invalid_chat_type'
  | 'unsupported_message_type'
  | 'invalid_create_time'
  | 'missing_content'
  | 'invalid_message_response';


export class FeishuDecodeError extends Error {
  constructor(readonly reason: FeishuDecodeReason) {
    super(`Feishu message event is malformed: ${reason}`);
    this.name = 'FeishuDecodeError';
  }
}

const MESSAGE_TYPES = ['text', 'post', 'image', 'file'] as const;
type SupportedMessageType = (typeof MESSAGE_TYPES)[number];

function isSupportedMessageType(value: unknown): value is SupportedMessageType {
  return typeof value === 'string' && (MESSAGE_TYPES as readonly string[]).includes(value);
}

function parseContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new FeishuDecodeError('content_not_json');
  }
}

function flattenPost(parsed: JsonObject): string {
  const post = parsed.post;
  if (!isObject(post)) throw new FeishuDecodeError('invalid_post_content');
  const langKey = Object.keys(post)[0];
  const body = langKey !== undefined ? post[langKey] : undefined;
  if (!isObject(body)) throw new FeishuDecodeError('invalid_post_content');
  const title = typeof body.title === 'string' ? body.title : '';
  const content = Array.isArray(body.content) ? body.content : [];
  const lines = content.map((paragraph) =>
    Array.isArray(paragraph)
      ? paragraph
          .filter(isObject)
          .map((element) => (typeof element.text === 'string' ? element.text : ''))
          .join('')
      : '',
  );
  return [title, ...lines].filter((line) => line.length > 0).join('\n');
}

function decodeMessageContent(
  type: SupportedMessageType,
  parsed: unknown,
): { text: string; resource?: NormalizedFeishuMessage['resource'] } {
  if (!isObject(parsed)) throw new FeishuDecodeError('invalid_content');
  if (type === 'text') {
    if (!nonEmptyString(parsed.text)) throw new FeishuDecodeError('invalid_text_content');
    return { text: parsed.text };
  }
  if (type === 'post') {
    return { text: flattenPost(parsed) };
  }
  if (type === 'image') {
    if (!nonEmptyString(parsed.image_key)) throw new FeishuDecodeError('invalid_image_content');
    return { text: '', resource: { key: parsed.image_key } };
  }
  if (!nonEmptyString(parsed.file_key)) throw new FeishuDecodeError('invalid_file_content');
  return {
    text: '',
    resource: {
      key: parsed.file_key,
      ...(nonEmptyString(parsed.file_name) ? { filename: parsed.file_name } : {}),
    },
  };
}

export function decodeReceivedMessage(raw: unknown): NormalizedFeishuMessage {
  if (!isObject(raw)) throw new FeishuDecodeError('not_an_object');
  if (!nonEmptyString(raw.event_id)) throw new FeishuDecodeError('missing_event_id');

  const sender = raw.sender;
  if (!isObject(sender)) throw new FeishuDecodeError('missing_sender');
  const senderOpenId = isObject(sender.sender_id) ? sender.sender_id.open_id : undefined;
  if (!nonEmptyString(senderOpenId)) throw new FeishuDecodeError('missing_sender_open_id');
  if (!nonEmptyString(sender.sender_type)) throw new FeishuDecodeError('missing_sender_type');

  const message = raw.message;
  if (!isObject(message)) throw new FeishuDecodeError('missing_message');
  if (!nonEmptyString(message.message_id)) throw new FeishuDecodeError('missing_message_id');
  if (!nonEmptyString(message.chat_id)) throw new FeishuDecodeError('missing_chat_id');
  if (message.chat_type !== 'p2p' && message.chat_type !== 'group') throw new FeishuDecodeError('invalid_chat_type');
  if (!isSupportedMessageType(message.message_type)) throw new FeishuDecodeError('unsupported_message_type');
  const createTime = Number(message.create_time);
  if (!Number.isFinite(createTime)) throw new FeishuDecodeError('invalid_create_time');
  if (!nonEmptyString(message.content)) throw new FeishuDecodeError('missing_content');

  const { text, resource } = decodeMessageContent(message.message_type, parseContent(message.content));
  const mentions = Array.isArray(message.mentions)
    ? message.mentions.flatMap((mention) =>
        isObject(mention) && isObject(mention.id) && nonEmptyString(mention.id.open_id) ? [mention.id.open_id] : [],
      )
    : [];

  return {
    eventId: raw.event_id,
    ...(nonEmptyString(raw.tenant_key) ? { tenantKey: raw.tenant_key } : {}),
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type,
    messageType: message.message_type,
    senderOpenId,
    senderType: sender.sender_type,
    createTime,
    ...(nonEmptyString(message.root_id) ? { rootId: message.root_id } : {}),
    ...(nonEmptyString(message.thread_id) ? { threadId: message.thread_id } : {}),
    text,
    mentions,
    ...(resource ? { resource } : {}),
  };
}

export function outgoingPayload(message: OutgoingMessage): { msgType: string; content: string } {
  switch (message.kind) {
    case 'text':
      return { msgType: 'text', content: JSON.stringify({ text: message.text }) };
    case 'card':
      return { msgType: 'interactive', content: JSON.stringify(message.card) };
    case 'image':
      return { msgType: 'image', content: JSON.stringify({ image_key: message.imageKey }) };
    case 'file':
      return { msgType: 'file', content: JSON.stringify({ file_key: message.fileKey }) };
  }
}

export function decodeMessageReceipt(response: unknown): MessageReceipt {
  if (!isObject(response) || !isObject(response.data) || !nonEmptyString(response.data.message_id)) {
    throw new FeishuDecodeError('invalid_message_response');
  }
  return {
    messageId: response.data.message_id,
    ...(nonEmptyString(response.data.chat_id) ? { chatId: response.data.chat_id } : {}),
  };
}
