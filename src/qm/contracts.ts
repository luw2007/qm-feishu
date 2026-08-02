import type {
  ApprovalView,
  BlobRef,
  Delivery,
  DeliveryAttachment,
  QueuedRun,
  RunView,
} from '../types.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export class QmContractError extends Error {
  constructor() {
    super('QM returned a malformed successful response');
    this.name = 'QmContractError';
  }
}

export abstract class QmRequestError extends Error {
  readonly status: number;
  readonly errorCode?: string;

  protected constructor(name: string, message: string, status: number, errorCode?: string) {
    super(message);
    this.name = name;
    this.status = status;
    if (errorCode !== undefined) this.errorCode = errorCode;
  }
}

export class QmAuthError extends QmRequestError {
  constructor(status: number, errorCode?: string) {
    super('QmAuthError', `QM authentication failed with HTTP ${status}`, status, errorCode);
  }
}

export class QmPermanentError extends QmRequestError {
  constructor(status: number, errorCode?: string) {
    super('QmPermanentError', `QM rejected the request with HTTP ${status}`, status, errorCode);
  }
}

export class QmTransientError extends QmRequestError {
  readonly retryAfterMs?: number;

  constructor(status: number, errorCode?: string, retryAfterMs?: number) {
    super('QmTransientError', `QM is temporarily unavailable with HTTP ${status}`, status, errorCode);
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export class QmTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`QM request timed out after ${timeoutMs}ms`);
    this.name = 'QmTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class QmNetworkError extends Error {
  constructor() {
    super('QM request failed before receiving an HTTP response');
    this.name = 'QmNetworkError';
  }
}

export function decodeQueuedRun(value: unknown): QueuedRun {
  if (!isObject(value) || value.status !== 'queued' || !nonEmptyString(value.runId)) throw new QmContractError();
  if (value.steered !== undefined && value.steered !== true) throw new QmContractError();
  return {
    runId: value.runId,
    queued: true,
    ...(value.steered === true ? { steered: true } : {}),
  };
}

export function decodeRunView(runId: string, value: unknown): RunView {
  if (!isObject(value)) throw new QmContractError();
  if (!['pending', 'running', 'done', 'failed'].includes(String(value.status))) throw new QmContractError();
  if (!('result' in value) || (value.result !== null && !isObject(value.result))) throw new QmContractError();
  if (!('startedAt' in value) || (value.startedAt !== null && !finiteNonNegative(value.startedAt))) {
    throw new QmContractError();
  }
  if (!('finishedAt' in value) || (value.finishedAt !== null && !finiteNonNegative(value.finishedAt))) {
    throw new QmContractError();
  }

  let status: RunView['status'];
  if (value.status === 'pending') status = 'queued';
  else if (value.status === 'running') status = 'running';
  else if (value.status === 'failed') status = 'failed';
  else {
    const result = value.result;
    status =
      isObject(result) && (result.stopped === true || result.reason === 'aborted')
        ? 'aborted'
        : isObject(result) && (result.status === 'failed' || result.status === 'refused')
          ? 'failed'
          : 'completed';
  }
  return { runId, status };
}

export function decodeActiveRun(value: unknown): string | undefined {
  if (!isObject(value) || !('runId' in value)) throw new QmContractError();
  if (value.runId === null) return undefined;
  if (!nonEmptyString(value.runId)) throw new QmContractError();
  return value.runId;
}

function decodeAttachment(value: unknown): DeliveryAttachment {
  if (!isObject(value)) throw new QmContractError();
  if (!nonEmptyString(value.blobId) || !nonEmptyString(value.name) || !nonEmptyString(value.mimetype)) {
    throw new QmContractError();
  }
  if (!finiteNonNegative(value.sizeBytes)) throw new QmContractError();

  if (value.artifactId !== undefined) {
    if (!nonEmptyString(value.artifactId)) throw new QmContractError();
    if (value.artifactViewerId !== undefined && !nonEmptyString(value.artifactViewerId)) throw new QmContractError();
    return {
      kind: 'file',
      id: value.artifactId,
      filename: value.name,
      mediaType: value.mimetype,
      sizeBytes: value.sizeBytes,
      ...(nonEmptyString(value.artifactViewerId) ? { viewerId: value.artifactViewerId } : {}),
    };
  }

  return {
    kind: 'blob',
    id: value.blobId,
    filename: value.name,
    mediaType: value.mimetype,
    sizeBytes: value.sizeBytes,
  };
}

export function decodeDeliveries(value: unknown): Delivery[] {
  if (!isObject(value) || !Array.isArray(value.deliveries)) throw new QmContractError();
  return value.deliveries.map((raw): Delivery => {
    if (!isObject(raw) || !isObject(raw.destination)) throw new QmContractError();
    if (
      !nonEmptyString(raw.id) ||
      !nonEmptyString(raw.idempotencyKey) ||
      !nonEmptyString(raw.destination.type) ||
      !nonEmptyString(raw.destination.target) ||
      typeof raw.text !== 'string'
    ) {
      throw new QmContractError();
    }
    if (raw.shadow !== undefined && typeof raw.shadow !== 'boolean') throw new QmContractError();
    if (raw.attachments !== undefined && !Array.isArray(raw.attachments)) throw new QmContractError();
    return {
      id: raw.id,
      idempotencyKey: raw.idempotencyKey,
      type: raw.destination.type,
      target: raw.destination.target,
      text: raw.text,
      ...(raw.shadow !== undefined ? { shadow: raw.shadow } : {}),
      ...(Array.isArray(raw.attachments) ? { attachments: raw.attachments.map(decodeAttachment) } : {}),
    };
  });
}

export function decodeBlobRef(value: unknown): BlobRef {
  if (!isObject(value) || !nonEmptyString(value.blobId) || !finiteNonNegative(value.sizeBytes)) {
    throw new QmContractError();
  }
  return { blobId: value.blobId, sizeBytes: value.sizeBytes };
}

export function decodeApproval(value: unknown): ApprovalView {
  if (!isObject(value) || !nonEmptyString(value.requestId)) throw new QmContractError();
  if (value.command !== undefined && typeof value.command !== 'string') throw new QmContractError();
  if (value.grantModes !== undefined && !isObject(value.grantModes)) throw new QmContractError();

  const grantModes = isObject(value.grantModes) ? value.grantModes : {};
  if (
    (grantModes.session !== undefined && typeof grantModes.session !== 'boolean') ||
    (grantModes.always !== undefined && typeof grantModes.always !== 'boolean')
  ) {
    throw new QmContractError();
  }

  let request: ApprovalView['request'];
  if (value.request !== undefined) {
    if (!isObject(value.request) || !isObject(value.request.actor) || !nonEmptyString(value.request.actor.externalId)) {
      throw new QmContractError();
    }
    if (value.request.actor.displayName !== undefined && typeof value.request.actor.displayName !== 'string') {
      throw new QmContractError();
    }
    request = {
      actor: {
        externalId: value.request.actor.externalId,
        ...(typeof value.request.actor.displayName === 'string'
          ? { displayName: value.request.actor.displayName }
          : {}),
      },
    };
  }

  return {
    requestId: value.requestId,
    status: 'pending',
    ...(typeof value.command === 'string' ? { command: value.command } : {}),
    grantModes: {
      once: true,
      session: grantModes.session === true,
      always: grantModes.always === true,
    },
    ...(request ? { request } : {}),
  };
}

export function decodePendingApprovalId(value: unknown): string | undefined {
  if (!isObject(value) || !('pending' in value)) throw new QmContractError();
  if (value.pending === null) return undefined;
  if (!isObject(value.pending) || value.pending.status !== 'pending_approval') throw new QmContractError();
  if (!Array.isArray(value.pending.pendingApprovals) || value.pending.pendingApprovals.length === 0) {
    throw new QmContractError();
  }
  const first: unknown = value.pending.pendingApprovals[0];
  if (!isObject(first) || !nonEmptyString(first.requestId)) throw new QmContractError();
  return first.requestId;
}

export function decodeOk(value: unknown): void {
  if (!isObject(value) || value.ok !== true) throw new QmContractError();
}

export function decodeAccepted(value: unknown): void {
  if (!isObject(value) || value.accepted !== true) throw new QmContractError();
}
