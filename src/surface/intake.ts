import { createHash } from 'node:crypto';

import type { FeishuPort, QmPort } from '../ports.js';
import type { NormalizedFeishuMessage, SurfaceAttachment, SurfaceEvent, SurfaceTurn } from '../types.js';
import { renderDeliveryTarget, renderThreadRef, resolveThreadRef } from './threads.js';

export type IntakeOptions = {
  botOpenId: string;
  tenantKey: string;
};

export type IntakeOutcome =
  | { kind: 'accepted'; runId: string; threadRef: string; destination: string; steered: boolean }
  | { kind: 'signaled'; runId: string; threadRef: string }
  | { kind: 'ignored'; reason: 'self' | 'non_user_sender' | 'unmentioned' | 'unsupported_message_type' }
  | {
      kind: 'rejected';
      reason:
        | 'external_tenant'
        | 'missing_identity'
        | 'ambiguous_mention'
        | 'attachment_empty'
        | 'attachment_oversized'
        | 'attachment_unavailable';
    }
  | { kind: 'refused'; threadRef: string };

// Minimal literal stop grammar for Step 4; extend to richer phrasing once QM's
// Slack-observed stop vocabulary is confirmed.
const STOP_TEXT = 'stop';

// Feishu's documented image/file upload ceilings; incoming resources are buffered once
// up to this bound before staging so memory use stays predictable.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

function isRefusedTurn(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 403;
}

function mentionCount(mentions: string[], openId: string): number {
  return mentions.filter((mention) => mention === openId).length;
}

type BoundedRead =
  | { kind: 'ok'; bytes: Uint8Array }
  | { kind: 'empty' }
  | { kind: 'oversize' }
  | { kind: 'stream_failure' };

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<BoundedRead> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'oversize' };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: 'stream_failure' };
  }
  if (total === 0) return { kind: 'empty' };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'ok', bytes };
}

type AttachmentStage =
  | { kind: 'attached'; attachment: SurfaceAttachment }
  | { kind: 'unsupported' }
  | { kind: 'rejected'; reason: 'attachment_empty' | 'attachment_oversized' | 'attachment_unavailable' };

async function stageIncomingAttachment(
  message: NormalizedFeishuMessage,
  ports: { qm: QmPort; feishu: FeishuPort },
): Promise<AttachmentStage> {
  const resource = message.resource;
  if (!resource || (message.messageType !== 'image' && message.messageType !== 'file')) {
    return { kind: 'unsupported' };
  }

  const maxBytes = message.messageType === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await ports.feishu.download({
      messageId: message.messageId,
      resourceKey: resource.key,
      kind: message.messageType,
    });
  } catch {
    return { kind: 'rejected', reason: 'attachment_unavailable' };
  }

  const read = await readBounded(stream, maxBytes);
  if (read.kind === 'empty') return { kind: 'rejected', reason: 'attachment_empty' };
  if (read.kind === 'oversize') return { kind: 'rejected', reason: 'attachment_oversized' };
  if (read.kind === 'stream_failure') return { kind: 'rejected', reason: 'attachment_unavailable' };

  const filename = resource.filename ?? resource.key;
  const mediaType = resource.mediaType ?? 'application/octet-stream';
  const sha256 = createHash('sha256').update(read.bytes).digest('hex');

  try {
    const blobRef = await ports.qm.stageBlob({ bytes: read.bytes, filename, mediaType, sha256 });
    return { kind: 'attached', attachment: { blobId: blobRef.blobId, filename, mediaType, sizeBytes: blobRef.sizeBytes } };
  } catch {
    return { kind: 'rejected', reason: 'attachment_unavailable' };
  }
}

export async function handleIncomingMessage(
  message: NormalizedFeishuMessage,
  ports: { qm: QmPort; feishu: FeishuPort },
  options: IntakeOptions,
): Promise<IntakeOutcome> {
  if (message.tenantKey === undefined || message.tenantKey !== options.tenantKey) {
    return { kind: 'rejected', reason: 'external_tenant' };
  }
  if (message.senderOpenId.trim().length === 0) {
    return { kind: 'rejected', reason: 'missing_identity' };
  }
  if (message.senderOpenId === options.botOpenId) {
    return { kind: 'ignored', reason: 'self' };
  }
  if (message.senderType !== 'user') {
    return { kind: 'ignored', reason: 'non_user_sender' };
  }

  if (message.chatType === 'group') {
    const count = mentionCount(message.mentions, options.botOpenId);
    if (count === 0) return { kind: 'ignored', reason: 'unmentioned' };
    if (count > 1) return { kind: 'rejected', reason: 'ambiguous_mention' };
  }

  let attachments: SurfaceAttachment[] | undefined;
  if (message.messageType === 'image' || message.messageType === 'file') {
    const staged = await stageIncomingAttachment(message, ports);
    if (staged.kind === 'unsupported') return { kind: 'ignored', reason: 'unsupported_message_type' };
    if (staged.kind === 'rejected') return { kind: 'rejected', reason: staged.reason };
    attachments = [staged.attachment];
  }

  const resolvedThread = resolveThreadRef(message);
  const threadRef = renderThreadRef(resolvedThread);

  if (message.messageType === 'text' && message.text.trim().toLowerCase() === STOP_TEXT) {
    const activeRunId = await ports.qm.activeRun(threadRef);
    if (activeRunId !== undefined) {
      await ports.qm.signalRun(activeRunId, { kind: 'abort' });
      return { kind: 'signaled', runId: activeRunId, threadRef };
    }
  }

  const destination = renderDeliveryTarget({
    kind: 'chat',
    chatId: message.chatId,
    rootMessageId: resolvedThread.kind === 'dm' ? message.messageId : resolvedThread.rootMessageId,
  });
  const idempotencyKey = `feishu:message:${message.messageId}`;

  const turn: SurfaceTurn = {
    text: message.text,
    actor: { externalId: message.senderOpenId },
    conversation: { id: message.chatId, kind: message.chatType === 'p2p' ? 'dm' : 'group' },
    threadRef,
    destination,
    surface: 'feishu',
    addressed: true,
    surfaceTools: false,
    idempotencyKey,
    origin: { kind: 'human', messageTs: message.messageId },
    triggerTs: message.createTime,
    displayText: message.text,
    ...(attachments !== undefined ? { attachments } : {}),
  };

  let queued;
  try {
    queued = await ports.qm.submitTurn(turn);
  } catch (error) {
    if (isRefusedTurn(error)) return { kind: 'refused', threadRef };
    throw error;
  }

  await ports.feishu.reply(message.messageId, {
    kind: 'text',
    text: 'Got it, working on it.',
    uuid: `ack:${message.messageId}`.slice(0, 50),
  });

  const threadTs = message.rootId ?? message.threadId;
  const event: SurfaceEvent = {
    container: message.chatId,
    ts: message.messageId,
    actorId: message.senderOpenId,
    text: message.text,
    ...(threadTs !== undefined ? { threadTs } : {}),
  };
  try {
    await ports.qm.ingestSurfaceEvents([event]);
  } catch {
    // Surface-cache publication is observable-only; it must never roll back an accepted turn.
  }

  return { kind: 'accepted', runId: queued.runId, threadRef, destination, steered: queued.steered === true };
}
