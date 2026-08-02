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

export type FeishuSdkEventSourceOptions = {
  appId: string;
  appSecret: string;
  domain?: string;
  verificationToken?: string;
  encryptKey?: string;
  createEventDispatcher?: (params: { verificationToken?: string; encryptKey?: string }) => EventDispatcherLike;
  createWsClient?: (params: { appId: string; appSecret: string; domain?: string }) => WsClientLike;
};

export class FeishuSdkEventSource implements FeishuEventSource {
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #domain: string | undefined;
  readonly #verificationToken: string | undefined;
  readonly #encryptKey: string | undefined;
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
    this.#createEventDispatcher = options.createEventDispatcher ?? ((params) => new EventDispatcher(params));
    this.#createWsClient = options.createWsClient ?? ((params) => new WSClient({
      appId: params.appId,
      appSecret: params.appSecret,
      ...(params.domain !== undefined ? { domain: params.domain } : {}),
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

    this.#wsClient = this.#createWsClient({
      appId: this.#appId,
      appSecret: this.#appSecret,
      ...(this.#domain !== undefined ? { domain: this.#domain } : {}),
    });
    await this.#wsClient.start({ eventDispatcher: dispatcher });
  }

  stop(): Promise<void> {
    this.#wsClient?.close?.({ force: true });
    return Promise.resolve();
  }
}
