import { createHash } from 'node:crypto';

import type { FeishuPort, QmPort } from '../ports.js';
import type { Delivery, DeliveryReceipt, FeishuTarget, MessageReceipt } from '../types.js';
import { KeyedQueue } from './keyed-queue.js';

const CHAT_TARGET = /^chat:([^:]+):message:([^:]+)$/;
const USER_TARGET = /^user:([^:]+)$/;

export function parseDeliveryTarget(target: string): FeishuTarget | undefined {
  const chatMatch = CHAT_TARGET.exec(target);
  if (chatMatch) {
    const chatId = chatMatch[1];
    const messageId = chatMatch[2];
    return chatId && messageId ? { kind: 'reply', chatId, messageId } : undefined;
  }
  const userMatch = USER_TARGET.exec(target);
  if (userMatch) {
    const openId = userMatch[1];
    return openId ? { kind: 'user', openId } : undefined;
  }
  return undefined;
}

function destinationKey(target: FeishuTarget): string {
  return target.kind === 'reply' ? `chat:${target.chatId}` : `user:${target.openId}`;
}

export function splitDeliveryText(text: string, maxChars: number): string[] {
  if (text.length === 0) return [''];
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += maxChars) {
    parts.push(text.slice(index, index + maxChars));
  }
  return parts;
}

export function derivePartUuid(idempotencyKey: string, partIndex: number, partKind: string): string {
  return createHash('sha256')
    .update(`${idempotencyKey}\0${String(partIndex)}\0${partKind}`)
    .digest('hex')
    .slice(0, 50);
}

export type DeliveryLogEvent = Record<string, unknown>;

export type DeliveryDispatcherOptions = {
  qm: QmPort;
  feishu: FeishuPort;
  claimPrincipalDeliveries?: boolean;
  leaseMs?: number;
  maxPartChars?: number;
  shutdownTimeoutMs?: number;
  log?: (event: DeliveryLogEvent) => void;
};

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new TypeError(`${name} must be a positive integer`);
  return resolved;
}

export class FeishuDeliveryDispatcher {
  readonly #qm: QmPort;
  readonly #feishu: FeishuPort;
  readonly #claimPrincipalDeliveries: boolean;
  readonly #leaseMs: number;
  readonly #maxPartChars: number;
  readonly #shutdownTimeoutMs: number;
  readonly #log: (event: DeliveryLogEvent) => void;
  readonly #queue = new KeyedQueue();
  readonly #inFlight = new Set<string>();
  readonly #polls = new Set<Promise<void>>();
  #stopped = false;

  constructor(options: DeliveryDispatcherOptions) {
    this.#qm = options.qm;
    this.#feishu = options.feishu;
    this.#claimPrincipalDeliveries = options.claimPrincipalDeliveries ?? false;
    this.#leaseMs = positiveInt(options.leaseMs, 30_000, 'leaseMs');
    this.#maxPartChars = positiveInt(options.maxPartChars, 20_000, 'maxPartChars');
    this.#shutdownTimeoutMs = positiveInt(options.shutdownTimeoutMs, 15_000, 'shutdownTimeoutMs');
    this.#log = options.log ?? (() => undefined);
  }

  poll(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const poll = (async () => {
      const types = this.#claimPrincipalDeliveries ? (['feishu', 'principal'] as const) : (['feishu'] as const);
      const claimed: Delivery[] = [];
      for (const type of types) {
        claimed.push(...(await this.#qm.claimDeliveries(type, this.#leaseMs)));
      }
      await Promise.all(claimed.map((delivery) => this.#dispatch(delivery)));
    })();
    this.#polls.add(poll);
    void poll.then(
      () => this.#polls.delete(poll),
      () => this.#polls.delete(poll),
    );
    return poll;
  }

  async stop(timeoutMs: number = this.#shutdownTimeoutMs): Promise<void> {
    this.#stopped = true;
    const active = [...this.#polls];
    const completed = Promise.allSettled(active).then(() => true);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    });
    const drained = await Promise.race([completed, timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    if (!drained) this.#log({ event: 'delivery_shutdown_timed_out', activeCount: active.length });
  }

  async #dispatch(delivery: Delivery): Promise<void> {
    if (this.#inFlight.has(delivery.id)) {
      this.#log({ event: 'delivery_duplicate_claim_skipped', deliveryId: delivery.id });
      return;
    }
    this.#inFlight.add(delivery.id);
    try {
      const target = parseDeliveryTarget(delivery.target);
      if (delivery.shadow || !target) {
        this.#log({
          event: 'delivery_terminal',
          deliveryId: delivery.id,
          reason: delivery.shadow ? 'shadow' : 'unsupported_target',
        });
        await this.#ack(delivery);
        return;
      }
      await this.#queue.run(destinationKey(target), () => this.#send(delivery, target));
    } finally {
      this.#inFlight.delete(delivery.id);
    }
  }

  async #send(delivery: Delivery, target: FeishuTarget): Promise<void> {
    const parts = splitDeliveryText(delivery.text, this.#maxPartChars);
    let lastReceipt: MessageReceipt | undefined;
    try {
      for (const [index, part] of parts.entries()) {
        const uuid = derivePartUuid(delivery.idempotencyKey, index, 'text');
        lastReceipt = await this.#feishu.send(target, { kind: 'text', text: part, uuid });
      }
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'UnknownError';
      if (typeof error === 'object' && error !== null && 'disposition' in error && error.disposition === 'permanent') {
        this.#log({ event: 'delivery_terminal', deliveryId: delivery.id, reason: 'permanent_send_failure', errorClass });
        await this.#ack(delivery);
        return;
      }
      this.#log({ event: 'delivery_send_failed', deliveryId: delivery.id, errorClass });
      return;
    }
    const receipt: DeliveryReceipt =
      target.kind === 'user' && lastReceipt?.chatId ? { threadRef: `feishu:dm:${lastReceipt.chatId}` } : {};
    await this.#ack(delivery, receipt);
  }

  async #ack(delivery: Delivery, receipt?: DeliveryReceipt): Promise<void> {
    try {
      await this.#qm.ackDelivery(delivery.id, receipt);
    } catch (error) {
      this.#log({
        event: 'delivery_ack_failed_recovering',
        deliveryId: delivery.id,
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
      try {
        await this.#qm.ackDeliveryByKey(delivery.idempotencyKey);
      } catch (recoveryError) {
        this.#log({
          event: 'delivery_ack_recovery_failed',
          deliveryId: delivery.id,
          errorClass: recoveryError instanceof Error ? recoveryError.name : 'UnknownError',
        });
      }
    }
  }
}
