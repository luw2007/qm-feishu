import type { FeishuPort, QmPort } from '../ports.js';
import type { ApprovalScope, ApprovalView, FeishuConversation, NormalizedCardAction, OutgoingMessage, RunView, SurfaceTurn } from '../types.js';
import { parseDeliveryTarget } from './deliveries.js';

type LogFn = (event: Record<string, unknown>) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
};

export type WatchApprovalOutcome =
  | { kind: 'card_sent'; requestId: string }
  | { kind: 'terminal'; status: RunView['status'] };

const ACTIVE_RUN_STATUSES: ReadonlySet<RunView['status']> = new Set(['queued', 'running']);

/**
 * A pending approval is not a normal durable delivery: it is discovered by
 * polling `pendingApproval(threadRef)` while the run stays active. The loop
 * stops at the first of two events (terminal run, or an approval appears),
 * so at most one card is ever sent per call.
 */
export async function watchApproval(
  input: WatchApprovalInput,
  ports: { qm: QmPort; feishu: FeishuPort },
  options: WatchApprovalOptions,
): Promise<WatchApprovalOutcome> {
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const log = options.log ?? (() => undefined);

  for (;;) {
    const run = await ports.qm.getRun(input.runId);
    if (!ACTIVE_RUN_STATUSES.has(run.status)) {
      return { kind: 'terminal', status: run.status };
    }

    const approval = await ports.qm.pendingApproval(input.threadRef);
    if (approval) {
      const target = parseDeliveryTarget(input.destination);
      if (!target) throw new Error(`watchApproval: malformed destination ${input.destination}`);
      await ports.feishu.send(target, options.renderCard(approval));
      log({ event: 'approval_card_sent', requestId: approval.requestId });
      return { kind: 'card_sent', requestId: approval.requestId };
    }

    await delay(pollIntervalMs);
  }
}

// --- callback: verify the operator, reload the approval, continue ---------

export type ApprovalContinuationContext = {
  threadRef: string;
  destination: string;
  conversation: FeishuConversation;
};

export type ApprovalActionOutcome =
  | { kind: 'accepted'; requestId: string; scope: ApprovalScope }
  | { kind: 'denied'; requestId: string }
  | { kind: 'stale'; requestId: string }
  | { kind: 'missing'; requestId: string }
  | { kind: 'malformed'; requestId: string }
  | { kind: 'mismatch'; requestId: string };

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
  }
}

/**
 * Resolves the card-action outcome and returns a callback response without
 * waiting for the QM continuation turn to run: the continuation is submitted
 * but its own agent run is never awaited here, so callback latency stays
 * independent of run duration.
 */
export async function handleCardAction(
  action: NormalizedCardAction,
  context: ApprovalContinuationContext,
  ports: { qm: QmPort },
  options: { log?: LogFn } = {},
): Promise<{ response: CardCallbackResponse; outcome: ApprovalActionOutcome }> {
  const log = options.log ?? (() => undefined);
  const approval = await ports.qm.getApproval(action.requestId);

  let outcome: ApprovalActionOutcome;
  if (!approval) {
    outcome = { kind: 'missing', requestId: action.requestId };
  } else if (approval.status !== 'pending') {
    outcome = { kind: 'stale', requestId: action.requestId };
  } else if (!approval.request?.actor?.externalId) {
    outcome = { kind: 'mismatch', requestId: action.requestId };
  } else if (approval.request.actor.externalId !== action.operatorOpenId) {
    outcome = { kind: 'mismatch', requestId: action.requestId };
  } else if (action.action === 'deny') {
    outcome = { kind: 'denied', requestId: action.requestId };
  } else if (!approval.grantModes[SCOPE_BY_ACTION[action.action]]) {
    outcome = { kind: 'malformed', requestId: action.requestId };
  } else {
    outcome = { kind: 'accepted', requestId: action.requestId, scope: SCOPE_BY_ACTION[action.action] };
  }

  const response = toastFor(outcome);

  if (outcome.kind === 'accepted' || outcome.kind === 'denied') {
    const turn: SurfaceTurn = {
      text: '',
      actor: { externalId: action.operatorOpenId },
      conversation: context.conversation,
      threadRef: context.threadRef,
      destination: context.destination,
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
    void ports.qm.submitTurn(turn).catch((error: unknown) => {
      log({
        event: 'approval_continuation_failed',
        requestId: action.requestId,
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    });
  } else {
    log({ event: 'approval_action_rejected', requestId: action.requestId, outcome: outcome.kind });
  }

  return { response, outcome };
}
