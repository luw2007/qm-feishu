import type { FeishuPort, QmPort } from '../ports.js';
import type { NormalizedFeishuMessage, SurfaceEvent, SurfaceTurn } from '../types.js';
import { renderDeliveryTarget, renderThreadRef, resolveThreadRef } from './threads.js';

export type IntakeOptions = {
  botOpenId: string;
  tenantKey: string;
};

export type IntakeOutcome =
  | { kind: 'accepted'; runId: string; threadRef: string; steered: boolean }
  | { kind: 'signaled'; runId: string; threadRef: string }
  | { kind: 'ignored'; reason: 'self' | 'unmentioned' | 'unsupported_message_type' }
  | { kind: 'rejected'; reason: 'external_tenant' | 'missing_identity' | 'ambiguous_mention' }
  | { kind: 'refused'; threadRef: string };

// Minimal literal stop grammar for Step 4; extend to richer phrasing once QM's
// Slack-observed stop vocabulary is confirmed.
const STOP_TEXT = 'stop';

function isRefusedTurn(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 403;
}

function mentionCount(mentions: string[], openId: string): number {
  return mentions.filter((mention) => mention === openId).length;
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

  if (message.chatType === 'group') {
    const count = mentionCount(message.mentions, options.botOpenId);
    if (count === 0) return { kind: 'ignored', reason: 'unmentioned' };
    if (count > 1) return { kind: 'rejected', reason: 'ambiguous_mention' };
  }

  if (message.messageType !== 'text' && message.messageType !== 'post') {
    return { kind: 'ignored', reason: 'unsupported_message_type' };
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

  return { kind: 'accepted', runId: queued.runId, threadRef, steered: queued.steered === true };
}
