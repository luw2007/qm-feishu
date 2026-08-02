import { createHash } from 'node:crypto';

import type { QmPort } from '../ports.js';
import type {
  ApprovalView,
  BlobRef,
  Delivery,
  DeliveryReceipt,
  DirectoryBatch,
  IncomingFile,
  QueuedRun,
  RunView,
  SurfaceEvent,
  SurfaceTurn,
} from '../types.js';
import {
  QmAuthError,
  QmContractError,
  QmNetworkError,
  QmPermanentError,
  QmRequestError,
  QmTimeoutError,
  QmTransientError,
  decodeAccepted,
  decodeActiveRun,
  decodeApproval,
  decodeBlobRef,
  decodeDeliveries,
  decodeOk,
  decodePendingApprovalId,
  decodeQueuedRun,
  decodeRunView,
} from './contracts.js';
import { signedRequestHeaders } from './source-auth.js';

export type QmHttpClientOptions = {
  baseUrl: string;
  signingSecret: string;
  requestTimeoutMs?: number;
  maxJsonResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

type RequestOptions = {
  json?: unknown;
  bytes?: Uint8Array;
  signatureTail?: string;
};

function encodedPathSegment(value: string): string {
  if (!value) throw new QmPermanentError(400, 'empty_path_identifier');
  return encodeURIComponent(value);
}

function query(params: Record<string, string | number>): string {
  return new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
}

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[a-z0-9_.-]{1,80}$/i.test(value)) return undefined;
  return value;
}
async function responseErrorCode(response: Response): Promise<string | undefined> {
  try {
    const value: unknown = await response.clone().json();
    if (typeof value !== 'object' || value === null) return undefined;
    const body = value as Record<string, unknown>;
    return safeErrorCode(body.error) ?? safeErrorCode(body.reason);
  } catch {
    return undefined;
  }
}

function retryAfterMs(response: Response, nowMs: number): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

async function decodeJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new QmContractError();
  if (!response.body) throw new QmContractError();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new QmContractError();
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (!text) throw new QmContractError();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new QmContractError();
  }
}

export class QmHttpClient implements QmPort {
  readonly #baseUrl: URL;
  readonly #signingSecret: string;
  readonly #requestTimeoutMs: number;
  readonly #maxJsonResponseBytes: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;

  constructor(options: QmHttpClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    if (this.#baseUrl.protocol !== 'http:' && this.#baseUrl.protocol !== 'https:') {
      throw new TypeError('QM base URL must use HTTP or HTTPS');
    }
    if (!options.signingSecret) throw new TypeError('QM signing secret is required');
    if (!Number.isSafeInteger(options.requestTimeoutMs ?? 10_000) || (options.requestTimeoutMs ?? 10_000) <= 0) {
      throw new TypeError('QM request timeout must be a positive integer');
    }
    if (!Number.isSafeInteger(options.maxJsonResponseBytes ?? 1_000_000) || (options.maxJsonResponseBytes ?? 1_000_000) <= 0) {
      throw new TypeError('QM JSON response limit must be a positive integer');
    }
    this.#baseUrl.pathname = this.#baseUrl.pathname.replace(/\/+$/, '') || '/';
    this.#baseUrl.search = '';
    this.#baseUrl.hash = '';
    this.#signingSecret = options.signingSecret;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#maxJsonResponseBytes = options.maxJsonResponseBytes ?? 1_000_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async #request(method: string, pathWithQuery: string, options: RequestOptions = {}): Promise<Response> {
    const route = new URL(pathWithQuery, 'http://qm-route.invalid');
    const url = new URL(this.#baseUrl);
    const basePath = this.#baseUrl.pathname === '/' ? '' : this.#baseUrl.pathname;
    url.pathname = `${basePath}${route.pathname}`;
    url.search = route.search;
    const signedPath = `${url.pathname}${url.search}`;
    const body =
      options.json === undefined
        ? options.bytes === undefined
          ? undefined
          : Uint8Array.from(options.bytes)
        : JSON.stringify(options.json);
    const signatureTail = options.signatureTail ?? (typeof body === 'string' ? body : '');
    const baseHeaders: Record<string, string> = { accept: 'application/json' };
    if (options.json !== undefined) baseHeaders['content-type'] = 'application/json';
    if (options.bytes !== undefined && options.signatureTail !== undefined) {
      baseHeaders['x-content-sha256'] = options.signatureTail;
    }
    const headers = signedRequestHeaders(
      this.#signingSecret,
      method,
      signedPath,
      signatureTail,
      baseHeaders,
      Math.floor(this.#now() / 1_000),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException('timed out', 'TimeoutError'));
    }, this.#requestTimeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof QmRequestError || error instanceof QmContractError) throw error;
      if (controller.signal.aborted) throw new QmTimeoutError(this.#requestTimeoutMs);
      throw new QmNetworkError();
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) return response;
    const code = await responseErrorCode(response);
    if (response.status === 401) throw new QmAuthError(response.status, code);
    if (response.status === 429 || response.status >= 500) {
      throw new QmTransientError(response.status, code, retryAfterMs(response, this.#now()));
    }
    throw new QmPermanentError(response.status, code);
  }

  async #json(method: string, pathWithQuery: string, json?: unknown): Promise<unknown> {
    const response = await this.#request(method, pathWithQuery, json === undefined ? {} : { json });
    try {
      return await decodeJson(response, this.#maxJsonResponseBytes);
    } catch (error) {
      if (error instanceof QmContractError) throw error;
      throw new QmNetworkError();
    }
  }

  async probe(): Promise<void> {
    decodeOk(await this.#json('GET', '/healthz'));
  }

  async submitTurn(input: SurfaceTurn): Promise<QueuedRun> {
    const body = {
      text: input.text,
      actor: input.actor,
      conversation: {
        kind: input.conversation.kind,
        threadRef: input.threadRef,
        channelRef: input.conversation.id,
        ...(input.conversation.name ? { channelName: input.conversation.name } : {}),
      },
      deliveryTarget: input.destination,
      surface: input.surface,
      addressed: input.addressed,
      surfaceTools: input.surfaceTools,
      idempotencyKey: input.idempotencyKey,
      origin: input.origin,
      triggerTs: String(input.triggerTs),
      displayText: input.displayText,
      ...(input.attachments?.length
        ? {
            attachments: input.attachments.map((attachment) => ({
              blobId: attachment.blobId,
              name: attachment.filename,
              mimetype: attachment.mediaType,
              sizeBytes: attachment.sizeBytes,
            })),
          }
        : {}),
      ...(input.approval ? { approval: input.approval } : {}),
      async: true,
    };
    return decodeQueuedRun(await this.#json('POST', '/v1/turns?async=1', body));
  }

  async getRun(runId: string): Promise<RunView> {
    return decodeRunView(runId, await this.#json('GET', `/v1/runs/${encodedPathSegment(runId)}`));
  }

  async activeRun(threadRef: string): Promise<string | undefined> {
    return decodeActiveRun(await this.#json('GET', `/v1/runs?${query({ threadRef })}`));
  }

  async signalRun(runId: string, signal: { kind: 'abort' | 'steer'; text?: string }): Promise<void> {
    const body = { kind: signal.kind, ...(signal.text !== undefined ? { text: signal.text } : {}) };
    decodeAccepted(await this.#json('POST', `/v1/runs/${encodedPathSegment(runId)}/signal`, body));
  }

  async claimDeliveries(type: string, leaseMs: number): Promise<Delivery[]> {
    return decodeDeliveries(await this.#json('GET', `/v1/deliveries?${query({ type, claimMs: leaseMs })}`));
  }

  async ackDelivery(id: string, receipt?: DeliveryReceipt): Promise<void> {
    const body = receipt?.threadRef ? { recipientThreadRef: receipt.threadRef } : {};
    decodeOk(await this.#json('POST', `/v1/deliveries/${encodedPathSegment(id)}/ack`, body));
  }

  async ackDeliveryByKey(idempotencyKey: string): Promise<void> {
    decodeOk(await this.#json('POST', '/v1/deliveries/ack-by-key', { idempotencyKey }));
  }

  async pendingApproval(threadRef: string): Promise<ApprovalView | null> {
    const id = decodePendingApprovalId(
      await this.#json('GET', `/v1/approvals/pending?${query({ threadRef })}`),
    );
    if (!id) return null;
    const approval = await this.getApproval(id);
    if (!approval) throw new QmContractError();
    return approval;
  }

  async getApproval(requestId: string): Promise<ApprovalView | null> {
    const path = `/v1/approvals/${encodedPathSegment(requestId)}`;
    let response: Response;
    try {
      response = await this.#request('GET', path);
    } catch (error) {
      if (error instanceof QmPermanentError && error.status === 404) return null;
      throw error;
    }
    try {
      return decodeApproval(await decodeJson(response, this.#maxJsonResponseBytes));
    } catch (error) {
      if (error instanceof QmContractError) throw error;
      throw new QmNetworkError();
    }
  }

  async stageBlob(file: IncomingFile): Promise<BlobRef> {
    const bytes = new Uint8Array(file.bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(file.sha256) || file.sha256 !== sha256) {
      throw new QmPermanentError(400, 'blob_digest_mismatch');
    }
    const response = await this.#request('POST', '/v1/blobs', {
      bytes,
      signatureTail: sha256,
    });
    try {
      return decodeBlobRef(await decodeJson(response, this.#maxJsonResponseBytes));
    } catch (error) {
      if (error instanceof QmContractError) throw error;
      throw new QmNetworkError();
    }
  }

  async readBlob(blobId: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.#request('GET', `/v1/blobs/${encodedPathSegment(blobId)}`);
    if (!response.body) throw new QmContractError();
    return response.body;
  }

  async readFileArtifact(artifactId: string, viewerId: string): Promise<ReadableStream<Uint8Array>> {
    const path = `/v1/files/${encodedPathSegment(artifactId)}/content?${query({ viewer: viewerId })}`;
    const response = await this.#request('GET', path);
    if (!response.body) throw new QmContractError();
    return response.body;
  }

  async pushDirectory(batch: DirectoryBatch): Promise<void> {
    const body = {
      ...(batch.members
        ? {
            members: batch.members.map((member) => ({
              principalId: member.principalId,
              displayName: member.displayName ?? member.principalId,
              type: 'internal',
            })),
          }
        : {}),
      ...(batch.channels
        ? {
            channels: batch.channels.map((channel) => ({
              channelId: channel.id,
              name: channel.name ?? channel.id,
            })),
          }
        : {}),
    };
    decodeOk(await this.#json('POST', '/v1/directory', body));
  }

  async ingestSurfaceEvents(events: SurfaceEvent[]): Promise<void> {
    const body = {
      surface: 'feishu',
      events: events.map((event) => ({
        container: event.container,
        ts: event.ts,
        ...(event.threadTs ? { sub: event.threadTs } : {}),
        ...(event.actorId ? { authorId: event.actorId } : {}),
        ...(event.text !== undefined ? { text: event.text } : {}),
        ...(event.files
          ? {
              files: event.files.map((file) => ({
                fileId: file.fileId,
                ...(file.name ? { name: file.name } : {}),
                ...(file.mediaType ? { mimetype: file.mediaType } : {}),
              })),
            }
          : {}),
      })),
    };
    decodeOk(await this.#json('POST', '/v1/surface-cache/ingest', body));
  }
}
