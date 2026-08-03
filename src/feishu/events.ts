import { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';

import type { FeishuEventSource } from '../ports.js';

type EventSourceHandlers = {
  onMessage(event: unknown): Promise<void>;
  onCardAction(event: unknown): Promise<unknown>;
};

type EventDispatcherLike = {
  register(handles: Record<string, (data: unknown) => unknown>): unknown;
};


type WsClientLike = {
  start(params: { eventDispatcher: unknown }): Promise<void>;
  close?(params?: { force?: boolean }): void;
};

export class FeishuLongConnectionError extends Error {
  constructor(cause?: unknown) {
    super('Feishu long connection failed', { cause });
    this.name = 'FeishuLongConnectionError';
  }
}

export type FeishuSdkEventSourceOptions = {
  appId: string;
  appSecret: string;
  domain?: string;
  verificationToken?: string;
  encryptKey?: string;
  awaitReady?: boolean;
  createEventDispatcher?: (params: { verificationToken?: string; encryptKey?: string }) => EventDispatcherLike;
  createWsClient?: (params: {
    appId: string;
    appSecret: string;
    domain?: string;
    onReady?(): void;
    onError?(error: unknown): void;
  }) => WsClientLike;
};

export class FeishuSdkEventSource implements FeishuEventSource {
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #domain: string | undefined;
  readonly #verificationToken: string | undefined;
  readonly #encryptKey: string | undefined;
  readonly #awaitReady: boolean;
  readonly #createEventDispatcher: NonNullable<FeishuSdkEventSourceOptions['createEventDispatcher']>;
  readonly #createWsClient: NonNullable<FeishuSdkEventSourceOptions['createWsClient']>;
  #wsClient: WsClientLike | undefined;

  constructor(options: FeishuSdkEventSourceOptions) {
    if (!options.appId) throw new TypeError('Feishu app ID is required');
    if (!options.appSecret) throw new TypeError('Feishu app secret is required');
    this.#appId = options.appId;
    this.#appSecret = options.appSecret;
    this.#domain = options.domain;
    this.#verificationToken = options.verificationToken;
    this.#encryptKey = options.encryptKey;
    this.#awaitReady = options.awaitReady ?? false;
    this.#createEventDispatcher = options.createEventDispatcher ?? ((params) => new EventDispatcher(params));
    this.#createWsClient = options.createWsClient ?? ((params) => new WSClient({
      appId: params.appId,
      appSecret: params.appSecret,
      ...(params.domain !== undefined ? { domain: params.domain } : {}),
      ...(params.onReady !== undefined ? { onReady: () => params.onReady?.() } : {}),
      ...(params.onError !== undefined ? { onError: (error: unknown) => params.onError?.(error) } : {}),
    }));
  }

  // Card actions arrive through the same EventDispatcher on long connections.

  async start(handlers: EventSourceHandlers): Promise<void> {
    const verificationParams = {
      ...(this.#verificationToken !== undefined ? { verificationToken: this.#verificationToken } : {}),
      ...(this.#encryptKey !== undefined ? { encryptKey: this.#encryptKey } : {}),
    };

    const dispatcher = this.#createEventDispatcher(verificationParams);
    dispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        await handlers.onMessage(data);
      },
      'card.action.trigger': async (data: unknown) => handlers.onCardAction(data),
    });

    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = this.#awaitReady
      ? new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        })
      : undefined;
    this.#wsClient = this.#createWsClient({
      appId: this.#appId,
      appSecret: this.#appSecret,
      ...(this.#domain !== undefined ? { domain: this.#domain } : {}),
      ...(this.#awaitReady
        ? {
            onReady: () => resolveReady?.(),
            onError: (error: unknown) => rejectReady?.(new FeishuLongConnectionError(error)),
          }
        : {}),
    });
    await this.#wsClient.start({ eventDispatcher: dispatcher });
    await ready;
  }

  stop(): Promise<void> {
    this.#wsClient?.close?.({ force: true });
    return Promise.resolve();
  }
}
