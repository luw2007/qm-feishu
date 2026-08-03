import { Client } from '@larksuiteoapi/node-sdk';
import type { Readable } from 'node:stream';

import type { FeishuPort } from '../ports.js';
import type { FeishuResourceKey, FeishuTarget, IncomingResource, MessageReceipt, OutgoingFile, OutgoingMessage } from '../types.js';
import { assertUploadable, feishuFileType, toWebStream } from './files.js';
import { decodeMessageReceipt, outgoingPayload } from './messages.js';
import { silentFeishuSdkLogger, type FeishuSdkLogger } from './sdk-logger.js';

export abstract class FeishuRequestError extends Error {
  readonly status: number;
  readonly feishuCode?: number;
  abstract readonly disposition: 'permanent' | 'transient';

  protected constructor(name: string, message: string, status: number, feishuCode?: number) {
    super(message);
    this.name = name;
    this.status = status;
    if (feishuCode !== undefined) this.feishuCode = feishuCode;
  }
}

export class FeishuPermanentError extends FeishuRequestError {
  readonly disposition = 'permanent' as const;
  constructor(status: number, feishuCode?: number) {
    super('FeishuPermanentError', `Feishu rejected the request with HTTP ${status}`, status, feishuCode);
  }
}

export class FeishuRateLimitedError extends FeishuRequestError {
  readonly disposition = 'transient' as const;
  readonly retryAfterMs?: number;

  constructor(status: number, feishuCode?: number, retryAfterMs?: number) {
    super('FeishuRateLimitedError', `Feishu rate-limited the request with HTTP ${status}`, status, feishuCode);
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export class FeishuTransientError extends FeishuRequestError {
  readonly disposition = 'transient' as const;
  constructor(status: number, feishuCode?: number) {
    super('FeishuTransientError', `Feishu is temporarily unavailable with HTTP ${status}`, status, feishuCode);
  }
}

export class FeishuUnavailableError extends Error {
  readonly disposition = 'transient' as const;
  constructor() {
    super('Feishu request failed before receiving an HTTP response');
    this.name = 'FeishuUnavailableError';
  }
}

export class FeishuContractError extends Error {
  readonly disposition = 'permanent' as const;
  constructor(reason: string) {
    super(`Feishu returned a malformed successful response: ${reason}`);
    this.name = 'FeishuContractError';
  }
}

export type FeishuRawMessageResponse = {
  code?: number;
  msg?: string;
  data?: { message_id?: string; chat_id?: string };
};

export type FeishuApiClient = {
  im: {
    v1: {
      message: {
        reply(payload: {
          data: { content: string; msg_type: string; reply_in_thread?: boolean; uuid?: string };
          path: { message_id: string };
        }): Promise<FeishuRawMessageResponse>;
        create(payload: {
          data: { receive_id: string; msg_type: string; content: string; uuid?: string };
          params: { receive_id_type: string };
        }): Promise<FeishuRawMessageResponse>;
        patch(payload: { data: { content: string }; path: { message_id: string } }): Promise<{ code?: number; msg?: string }>;
      };
      image: {
        create(payload: { data: { image_type: string; image: Buffer } }): Promise<{ image_key?: string } | null>;
      };
      file: {
        create(payload: {
          data: { file_type: string; file_name: string; file: Buffer };
        }): Promise<{ file_key?: string } | null>;
      };
      messageResource: {
        get(payload: {
          params: { type: string };
          path: { message_id: string; file_key: string };
        }): Promise<{ getReadableStream: () => Readable }>;
      };
      chat: {
        list(payload?: { params?: { page_size?: number } }): Promise<{ code?: number; msg?: string }>;
      };
    };
  };
};

function extractAxiosResponse(error: unknown): { status: number; data?: unknown; headers?: unknown } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const response = (error as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null) return undefined;
  const status = (response as { status?: unknown }).status;
  if (typeof status !== 'number') return undefined;
  return response as { status: number; data?: unknown; headers?: unknown };
}

function extractFeishuCode(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const code = (data as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

function retryAfterMs(headers: unknown): number | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  const value = (headers as Record<string, unknown>)['retry-after'];
  if (typeof value !== 'string') return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : undefined;
}

const FEISHU_FREQUENCY_LIMIT_CODE = 99991400;

export function feishuResponseError(status: number, feishuCode: number): FeishuRequestError {
  return feishuCode === FEISHU_FREQUENCY_LIMIT_CODE
    ? new FeishuRateLimitedError(status, feishuCode)
    : new FeishuPermanentError(status, feishuCode);
}

function classifyFeishuFailure(error: unknown): Error {
  const response = extractAxiosResponse(error);
  if (!response) return new FeishuUnavailableError();
  const feishuCode = extractFeishuCode(response.data);
  if (response.status === 429 || feishuCode === FEISHU_FREQUENCY_LIMIT_CODE) {
    return new FeishuRateLimitedError(response.status, feishuCode, retryAfterMs(response.headers));
  }
  if (response.status >= 500) return new FeishuTransientError(response.status, feishuCode);
  return new FeishuPermanentError(response.status, feishuCode);
}

export type FeishuSdkClientOptions = {
  appId: string;
  appSecret: string;
  domain?: string;
  client?: FeishuApiClient;
  createClient?: (options: {
    appId: string;
    appSecret: string;
    domain?: string;
    logger: FeishuSdkLogger;
  }) => FeishuApiClient;
};

export class FeishuSdkClient implements FeishuPort {
  readonly #client: FeishuApiClient;

  constructor(options: FeishuSdkClientOptions) {
    if (!options.appId) throw new TypeError('Feishu app ID is required');
    if (!options.appSecret) throw new TypeError('Feishu app secret is required');
    this.#client = options.client ?? (options.createClient ?? ((params) => new Client(params) as unknown as FeishuApiClient))({
      appId: options.appId,
      appSecret: options.appSecret,
      ...(options.domain !== undefined ? { domain: options.domain } : {}),
      logger: silentFeishuSdkLogger,
    });
  }

  async #call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw classifyFeishuFailure(error);
    }
  }

  async probe(): Promise<void> {
    const response = await this.#call(() => this.#client.im.v1.chat.list({ params: { page_size: 1 } }));
    if (response.code !== undefined && response.code !== 0) throw feishuResponseError(200, response.code);
  }

  async reply(messageId: string, message: OutgoingMessage): Promise<MessageReceipt> {
    const { msgType, content } = outgoingPayload(message);
    const response = await this.#call(() =>
      this.#client.im.v1.message.reply({
        data: { content, msg_type: msgType, reply_in_thread: true, uuid: message.uuid },
        path: { message_id: messageId },
      }),
    );
    if (response.code !== undefined && response.code !== 0) throw feishuResponseError(200, response.code);
    return decodeMessageReceipt(response);
  }

  async send(target: FeishuTarget, message: OutgoingMessage): Promise<MessageReceipt> {
    if (target.kind === 'reply') return this.reply(target.messageId, message);
    const { msgType, content } = outgoingPayload(message);
    const response = await this.#call(() =>
      this.#client.im.v1.message.create({
        data: { receive_id: target.openId, msg_type: msgType, content, uuid: message.uuid },
        params: { receive_id_type: 'open_id' },
      }),
    );
    if (response.code !== undefined && response.code !== 0) throw feishuResponseError(200, response.code);
    return decodeMessageReceipt(response);
  }

  async update(messageId: string, message: OutgoingMessage): Promise<void> {
    if (message.kind !== 'card') throw new TypeError('Feishu message updates only support card payloads');
    const response = await this.#call(() =>
      this.#client.im.v1.message.patch({ data: { content: JSON.stringify(message.card) }, path: { message_id: messageId } }),
    );
    if (response.code !== undefined && response.code !== 0) throw feishuResponseError(200, response.code);
  }

  async download(resource: IncomingResource): Promise<ReadableStream<Uint8Array>> {
    const response = await this.#call(() =>
      this.#client.im.v1.messageResource.get({
        params: { type: resource.kind },
        path: { message_id: resource.messageId, file_key: resource.resourceKey },
      }),
    );
    return toWebStream(response.getReadableStream());
  }

  async upload(file: OutgoingFile): Promise<FeishuResourceKey> {
    assertUploadable(file);
    const bytes = Buffer.from(file.bytes);
    if (file.kind === 'image') {
      const response = await this.#call(() => this.#client.im.v1.image.create({ data: { image_type: 'message', image: bytes } }));
      if (!response?.image_key) throw new FeishuContractError('missing image_key');
      return { kind: 'image', key: response.image_key };
    }
    const response = await this.#call(() =>
      this.#client.im.v1.file.create({
        data: { file_type: feishuFileType(file.mediaType), file_name: file.filename, file: bytes },
      }),
    );
    if (!response?.file_key) throw new FeishuContractError('missing file_key');
    return { kind: 'file', key: response.file_key };
  }
}
