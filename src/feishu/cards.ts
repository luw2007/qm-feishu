import type { ApprovalScope, ApprovalView, NormalizedCardAction } from '../types.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export class FeishuCardDecodeError extends Error {
  constructor(reason: string) {
    super(`Feishu card action is malformed: ${reason}`);
    this.name = 'FeishuCardDecodeError';
  }
}

const CARD_ACTIONS = ['allow_once', 'allow_session', 'allow_always', 'deny'] as const;
type CardActionKind = (typeof CARD_ACTIONS)[number];

function isCardActionKind(value: unknown): value is CardActionKind {
  return typeof value === 'string' && (CARD_ACTIONS as readonly string[]).includes(value);
}

/**
 * Accepts either the schema-2.0 envelope ({header, event}) or a flattened
 * event body, since the SDK's CardActionHandler.invoke(data: any) signature
 * does not pin down which shape reaches the registered card handler.
 */
export function decodeCardAction(raw: unknown): NormalizedCardAction {
  if (!isObject(raw)) throw new FeishuCardDecodeError('not_an_object');

  const header = isObject(raw.header) ? raw.header : raw;
  const eventId = nonEmptyString(header.event_id) ? header.event_id : undefined;
  if (!eventId) throw new FeishuCardDecodeError('missing_event_id');
  const tenantKey = nonEmptyString(header.tenant_key) ? header.tenant_key : undefined;
  if (!tenantKey) throw new FeishuCardDecodeError('missing_tenant_key');
  const appId = nonEmptyString(header.app_id) ? header.app_id : undefined;
  if (!appId) throw new FeishuCardDecodeError('missing_app_id');

  const body = isObject(raw.event) ? raw.event : raw;
  const operator = isObject(body.operator) ? body.operator : undefined;
  const operatorOpenId = nonEmptyString(operator?.open_id) ? operator.open_id : undefined;
  if (!operatorOpenId) throw new FeishuCardDecodeError('missing_verified_operator');
  const operatorTenantKey = nonEmptyString(operator?.tenant_key) ? operator.tenant_key : undefined;
  if (!operatorTenantKey) throw new FeishuCardDecodeError('missing_operator_tenant_key');

  const value = isObject(body.action) ? body.action.value : undefined;
  if (!isObject(value) || !nonEmptyString(value.requestId)) throw new FeishuCardDecodeError('missing_request_id');
  if (!isCardActionKind(value.action)) throw new FeishuCardDecodeError('invalid_action');

  return {
    eventId,
    tenantKey,
    appId,
    operatorOpenId,
    operatorTenantKey,
    requestId: value.requestId,
    action: value.action,
  };
}

const GRANTABLE_ACTIONS: ReadonlyArray<{ action: CardActionKind; scope: ApprovalScope; label: string }> = [
  { action: 'allow_once', scope: 'once', label: 'Allow once' },
  { action: 'allow_session', scope: 'session', label: 'Allow for session' },
  { action: 'allow_always', scope: 'always', label: 'Always allow' },
];

/**
 * Card button values carry only requestId/action; authenticity comes from the
 * verified callback operator and a server-side approval reload, never from
 * card-embedded actor or command data.
 */
export function renderApprovalCard(approval: ApprovalView): { kind: 'card'; card: Record<string, unknown>; uuid: string } {
  const grantedActions = GRANTABLE_ACTIONS.filter(({ scope }) => approval.grantModes[scope]);

  const buttons = [
    ...grantedActions.map(({ action, label }) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      type: 'primary',
      value: { requestId: approval.requestId, action },
    })),
    {
      tag: 'button',
      text: { tag: 'plain_text', content: 'Deny' },
      type: 'danger',
      value: { requestId: approval.requestId, action: 'deny' },
    },
  ];

  return {
    kind: 'card',
    uuid: `approval:${approval.requestId}`.slice(0, 50),
    card: {
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: 'div',
          text: { tag: 'plain_text', content: approval.command ? `Approval requested:\n${approval.command}` : 'Approval requested' },
        },
        { tag: 'action', actions: buttons },
      ],
    },
  };
}
