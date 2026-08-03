import type { FeishuPort, QmPort } from '../ports.js';
import type { ApprovalScope, ApprovalView, NormalizedCardAction, OutgoingMessage, RunView, SurfaceTurn } from '../types.js';
import { parseDeliveryTarget } from './deliveries.js';

type LogFn = (event: Record<string, unknown>) => void;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => { resolve(undefined); }, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    resolve(undefined);
  }, { once: true });
  return promise;
}

export function deriveApprovalIdempotencyKey(requestId: string, action: string, eventId: string): string {
  return `feishu:approval:${requestId}:${action}:${eventId}`;
}

// --- watcher: poll the pending approval for a queued run -------------------

export type WatchApprovalInput = {
  runId: string;
  threadRef: string;
  destination: string;
};

export type WatchApprovalOptions = {
  renderCard: (approval: ApprovalView) => OutgoingMessage;
  pollIntervalMs?: number;
  log?: LogFn;
  signal?: AbortSignal;
};

export type WatchApprovalOutcome =
  | { kind: 'card_sent'; requestId: string }
  | { kind: 'terminal'; status: RunView['status'] }
  | { kind: 'cancelled' };

const ACTIVE_RUN_STATUSES: ReadonlySet<RunView['status']> = new Set(['queued', 'running']);

function isTransientWatcherError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { disposition?: unknown }).disposition === 'transient';
}

function terminalMessage(runId: string, status: RunView['status']): OutgoingMessage | undefined {
  if (status === 'failed') {
    return { kind: 'text', text: 'The run failed.', uuid: `terminal:failed:${runId}`.slice(0, 50) };
  }
  if (status === 'aborted') {
    return { kind: 'text', text: 'The run was stopped.', uuid: `terminal:aborted:${runId}`.slice(0, 50) };
  }
  return undefined;
}

/**
 * Pending approval is authoritative even when collect-mode has made the run
 * appear terminal, so every poll checks it before the run disposition.
 */
export async function watchApproval(
  input: WatchApprovalInput,
  ports: { qm: QmPort; feishu: FeishuPort },
  options: WatchApprovalOptions,
): Promise<WatchApprovalOutcome> {
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const log = options.log ?? (() => undefined);

  for (;;) {
    if (options.signal?.aborted) return { kind: 'cancelled' };
    try {
      const approval = await ports.qm.pendingApproval(input.threadRef);
      if (options.signal?.aborted) return { kind: 'cancelled' };
      if (approval) {
        const target = parseDeliveryTarget(input.destination);
        if (!target) throw new Error(`watchApproval: malformed destination ${input.destination}`);
        await ports.feishu.send(target, options.renderCard(approval));
        log({ event: 'approval_card_sent', requestId: approval.requestId });
        return { kind: 'card_sent', requestId: approval.requestId };
      }

      const run = await ports.qm.getRun(input.runId);
      if (options.signal?.aborted) return { kind: 'cancelled' };
      if (!ACTIVE_RUN_STATUSES.has(run.status)) {
        const message = terminalMessage(input.runId, run.status);
        if (message) {
          const target = parseDeliveryTarget(input.destination);
          if (!target) throw new Error(`watchApproval: malformed destination ${input.destination}`);
          await ports.feishu.send(target, message);
          log({ event: 'approval_terminal_notice_sent', runId: input.runId, status: run.status });
        }
        return { kind: 'terminal', status: run.status };
      }
    } catch (error) {
      if (!isTransientWatcherError(error)) throw error;
      log({ event: 'approval_watch_retry', runId: input.runId, errorClass: error instanceof Error ? error.name : 'UnknownError' });
    }

    await delay(pollIntervalMs, options.signal);
  }
}

// --- callback: verify the operator, reload the approval, continue ---------


export type ApprovalActionOutcome =
  | { kind: 'accepted'; requestId: string; scope: ApprovalScope }
  | { kind: 'denied'; requestId: string }
  | { kind: 'stale'; requestId: string }
  | { kind: 'missing'; requestId: string }
  | { kind: 'malformed'; requestId: string }
  | { kind: 'mismatch'; requestId: string }
  | { kind: 'failed'; requestId: string };

export type ApprovalContinuation = {
  runId: string;
  threadRef: string;
  destination: string;
};

export type CardCallbackResponse = {
  toast: { type: 'success' | 'error'; content: string };
};

const SCOPE_BY_ACTION: Record<'allow_once' | 'allow_session' | 'allow_always', ApprovalScope> = {
  allow_once: 'once',
  allow_session: 'session',
  allow_always: 'always',
};

function toastFor(outcome: ApprovalActionOutcome): CardCallbackResponse {
  switch (outcome.kind) {
    case 'accepted':
      return { toast: { type: 'success', content: 'Approved.' } };
    case 'denied':
      return { toast: { type: 'success', content: 'Denied.' } };
    case 'stale':
      return { toast: { type: 'error', content: 'This approval request is no longer pending.' } };
    case 'missing':
      return { toast: { type: 'error', content: 'This approval request could not be found.' } };
    case 'malformed':
      return { toast: { type: 'error', content: 'That approval scope is not permitted for this request.' } };
    case 'mismatch':
      return { toast: { type: 'error', content: 'Only the requester can act on this approval.' } };
    case 'failed':
      return { toast: { type: 'error', content: 'This action could not be processed.' } };
  }
}

const CALLBACK_DEADLINE_MS = 2500;

type DeadlineResult<T> = { kind: 'value'; value: T } | { kind: 'deadline' };

function withinDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<DeadlineResult<T>> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return Promise.resolve({ kind: 'deadline' });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ kind: 'deadline' });
    }, remainingMs);
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: 'value', value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('Promise rejected with a non-Error value'));
      },
    );
  });
}

export type ApprovalActionResult = {
  response: CardCallbackResponse;
  outcome: ApprovalActionOutcome;
  continuation?: ApprovalContinuation;
  lateContinuation?: Promise<ApprovalContinuation | undefined>;
};

export async function handleCardAction(
  action: NormalizedCardAction,
  ports: { qm: QmPort },
  options: { log?: LogFn; deadlineMs?: number } = {},
): Promise<ApprovalActionResult> {
  const log = options.log ?? (() => undefined);
  const deadlineAt = Date.now() + (options.deadlineMs ?? CALLBACK_DEADLINE_MS);
  let approval: ApprovalView | null;
  try {
    const loaded = await withinDeadline(ports.qm.getApproval(action.requestId), deadlineAt);
    if (loaded.kind === 'deadline') throw new Error('ApprovalCallbackDeadline');
    approval = loaded.value;
  } catch (error) {
    const outcome: ApprovalActionOutcome = { kind: 'failed', requestId: action.requestId };
    log({ event: 'approval_action_failed', requestId: action.requestId, errorClass: error instanceof Error ? error.name : 'UnknownError' });
    return { response: toastFor(outcome), outcome };
  }
  const request = approval?.request;

  let outcome: ApprovalActionOutcome;
  if (!approval) {
    outcome = { kind: 'missing', requestId: action.requestId };
  } else if (approval.status !== 'pending') {
    outcome = { kind: 'stale', requestId: action.requestId };
  } else if (
    request?.actor.externalId !== action.operatorOpenId ||
    request.surface !== 'feishu' ||
    !request.deliveryTarget ||
    !request.conversation
  ) {
    outcome = { kind: 'mismatch', requestId: action.requestId };
  } else if (action.action === 'deny') {
    outcome = { kind: 'denied', requestId: action.requestId };
  } else if (!approval.grantModes[SCOPE_BY_ACTION[action.action]]) {
    outcome = { kind: 'malformed', requestId: action.requestId };
  } else {
    outcome = { kind: 'accepted', requestId: action.requestId, scope: SCOPE_BY_ACTION[action.action] };
  }

  if (
    (outcome.kind === 'accepted' || outcome.kind === 'denied') &&
    request?.conversation &&
    request.deliveryTarget
  ) {
    const conversation = request.conversation;
    const destination = request.deliveryTarget;
    const turn: SurfaceTurn = {
      text: '',
      actor: { externalId: action.operatorOpenId },
      conversation: { id: conversation.channelRef, kind: conversation.kind },
      threadRef: conversation.threadRef,
      destination,
      surface: 'feishu',
      addressed: true,
      surfaceTools: false,
      idempotencyKey: deriveApprovalIdempotencyKey(action.requestId, action.action, action.eventId),
      origin: { kind: 'human', messageTs: action.eventId },
      triggerTs: Date.now(),
      displayText: '',
      approval:
        outcome.kind === 'accepted'
          ? { requestId: action.requestId, approved: true, scope: outcome.scope }
          : { requestId: action.requestId, approved: false },
    };
    const submission = ports.qm.submitTurn(turn);
    try {
      const queued = await withinDeadline(submission, deadlineAt);
      if (queued.kind === 'value') {
        return {
          response: toastFor(outcome),
          outcome,
          continuation: { runId: queued.value.runId, threadRef: conversation.threadRef, destination },
        };
      }

      const failed: ApprovalActionOutcome = { kind: 'failed', requestId: action.requestId };
      const lateContinuation = submission.then(
        (lateQueued): ApprovalContinuation => ({
          runId: lateQueued.runId,
          threadRef: conversation.threadRef,
          destination,
        }),
        (error: unknown) => {
          log({
            event: 'approval_continuation_late_failed',
            requestId: action.requestId,
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          });
          return undefined;
        },
      );
      log({ event: 'approval_continuation_timed_out', requestId: action.requestId });
      return { response: toastFor(failed), outcome: failed, lateContinuation };
    } catch (error) {
      const failed: ApprovalActionOutcome = { kind: 'failed', requestId: action.requestId };
      log({ event: 'approval_continuation_failed', requestId: action.requestId, errorClass: error instanceof Error ? error.name : 'UnknownError' });
      return { response: toastFor(failed), outcome: failed };
    }
  }

  log({ event: 'approval_action_rejected', requestId: action.requestId, outcome: outcome.kind });
  return { response: toastFor(outcome), outcome };
}
