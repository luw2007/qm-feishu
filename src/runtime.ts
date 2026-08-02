import type { FeishuSurfaceConfig, ResolvedFeishuSurfaceConfig } from './config.js';
import { resolveConfig } from './config.js';
import type { Logger } from './logging.js';
import { createLogger } from './logging.js';
import type { HealthServer } from './health.js';
import { startHealthServer } from './health.js';
import type { FeishuEventSource, FeishuPort, QmPort } from './ports.js';
import type { ApprovalView, NormalizedCardAction, NormalizedFeishuMessage, OutgoingMessage } from './types.js';
import { QmHttpClient } from './qm/client.js';
import { FeishuSdkClient } from './feishu/client.js';
import { FeishuSdkEventSource } from './feishu/events.js';
import { decodeCardAction, renderApprovalCard as defaultRenderApprovalCard } from './feishu/cards.js';
import { decodeReceivedMessage } from './feishu/messages.js';
import { handleIncomingMessage } from './surface/intake.js';
import { FeishuDeliveryDispatcher } from './surface/deliveries.js';
import { handleCardAction, watchApproval } from './surface/approvals.js';
import type { CardCallbackResponse } from './surface/approvals.js';

export type FeishuSurfaceHandle = {
  stop(): Promise<void>;
};

export type RuntimeDeps = {
  createQmClient?: (config: ResolvedFeishuSurfaceConfig) => QmPort;
  createFeishuClient?: (config: ResolvedFeishuSurfaceConfig) => FeishuPort;
  createEventSource?: (config: ResolvedFeishuSurfaceConfig) => FeishuEventSource;
  createHealthServer?: (options: { host: string; port: number; metrics?: () => Record<string, number> }) => Promise<HealthServer>;
  renderApprovalCard?: (approval: ApprovalView) => OutgoingMessage;
  log?: Logger;
  now?: () => number;
};


type RuntimeMetrics = {
  deliveryBacklog: number;
  deliveryClaims: number;
  leaseReclaims: number;
  terminalDispositions: number;
  approvalWatcherOutcomes: number;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function defaultCreateQmClient(config: ResolvedFeishuSurfaceConfig): QmPort {
  return new QmHttpClient({
    baseUrl: config.coreApiUrl,
    signingSecret: config.coreSigningSecret,
    requestTimeoutMs: config.requestTimeoutMs,
  });
}

function defaultCreateFeishuClient(config: ResolvedFeishuSurfaceConfig): FeishuPort {
  return new FeishuSdkClient({ appId: config.feishuAppId, appSecret: config.feishuAppSecret });
}

function defaultCreateEventSource(config: ResolvedFeishuSurfaceConfig): FeishuEventSource {
  return new FeishuSdkEventSource({ appId: config.feishuAppId, appSecret: config.feishuAppSecret });
}

function instrumentDeliveryQm(qm: QmPort, log: Logger, metrics: RuntimeMetrics): QmPort {
  const seenDeliveryIds = new Set<string>();
  const outstandingDeliveryIds = new Set<string>();
  const deliveryIdByKey = new Map<string, string>();
  return {
    probe: qm.probe.bind(qm),
    submitTurn: qm.submitTurn.bind(qm),
    getRun: qm.getRun.bind(qm),
    activeRun: qm.activeRun.bind(qm),
    signalRun: qm.signalRun.bind(qm),
    pendingApproval: qm.pendingApproval.bind(qm),
    getApproval: qm.getApproval.bind(qm),
    stageBlob: qm.stageBlob.bind(qm),
    readBlob: qm.readBlob.bind(qm),
    readFileArtifact: qm.readFileArtifact.bind(qm),
    pushDirectory: qm.pushDirectory.bind(qm),
    ingestSurfaceEvents: qm.ingestSurfaceEvents.bind(qm),
    claimDeliveries: async (type, leaseMs) => {
      const claimed = await qm.claimDeliveries(type, leaseMs);
      metrics.deliveryClaims += claimed.length;
      for (const delivery of claimed) {
        if (seenDeliveryIds.has(delivery.id)) metrics.leaseReclaims += 1;
        seenDeliveryIds.add(delivery.id);
        outstandingDeliveryIds.add(delivery.id);
        deliveryIdByKey.set(delivery.idempotencyKey, delivery.id);
      }
      metrics.deliveryBacklog = outstandingDeliveryIds.size;
      log({ event: 'delivery_claimed', level: 'debug', type, count: claimed.length });
      return claimed;
    },
    ackDelivery: async (id, receipt) => {
      await qm.ackDelivery(id, receipt);
      outstandingDeliveryIds.delete(id);
      metrics.deliveryBacklog = outstandingDeliveryIds.size;
      log({ event: 'delivery_acked', level: 'debug', deliveryId: id });
    },
    ackDeliveryByKey: async (idempotencyKey) => {
      await qm.ackDeliveryByKey(idempotencyKey);
      const deliveryId = deliveryIdByKey.get(idempotencyKey);
      if (deliveryId !== undefined) outstandingDeliveryIds.delete(deliveryId);
      metrics.deliveryBacklog = outstandingDeliveryIds.size;
      log({ event: 'delivery_acked_by_key', level: 'debug' });
    },
  };
}

export function startFeishuSurface(config: FeishuSurfaceConfig): Promise<FeishuSurfaceHandle> {
  return runFeishuSurface(config, {});
}

export async function runFeishuSurface(config: FeishuSurfaceConfig, deps: RuntimeDeps): Promise<FeishuSurfaceHandle> {
  const resolved = resolveConfig(config);
  const metrics: RuntimeMetrics = {
    deliveryBacklog: 0,
    deliveryClaims: 0,
    leaseReclaims: 0,
    terminalDispositions: 0,
    approvalWatcherOutcomes: 0,
  };
  const sink = deps.log ?? createLogger({ level: resolved.logLevel, ...(deps.now ? { now: deps.now } : {}) });
  const log: Logger = (event) => {
    if (event.event === 'delivery_terminal') metrics.terminalDispositions += 1;
    sink(event);
  };
  const qm = (deps.createQmClient ?? defaultCreateQmClient)(resolved);
  const feishu = (deps.createFeishuClient ?? defaultCreateFeishuClient)(resolved);
  const eventSource = (deps.createEventSource ?? defaultCreateEventSource)(resolved);
  const health = await (deps.createHealthServer ?? startHealthServer)({
    host: resolved.healthHost,
    port: resolved.healthPort,
    metrics: () => ({ ...metrics }),
  });
  const approvalAbort = new AbortController();
  const activeApprovalWatches = new Set<Promise<void>>();
  const renderCard = deps.renderApprovalCard ?? defaultRenderApprovalCard;
  const deliveryQm = instrumentDeliveryQm(qm, log, metrics);
  const dispatcher = new FeishuDeliveryDispatcher({
    qm: deliveryQm,
    feishu,
    claimPrincipalDeliveries: resolved.claimPrincipalDeliveries,
    leaseMs: resolved.deliveryClaimMs,
    shutdownTimeoutMs: resolved.shutdownTimeoutMs,
    log,
  });
  let eventSourceStarted = false;
  let stopped = false;
  const isStopped = (): boolean => stopped;

  function watchAcceptedApproval(input: { runId: string; threadRef: string; destination: string }): void {
    if (stopped) return;
    const watch: Promise<void> = watchApproval(
      input,
      { qm, feishu },
      { renderCard, pollIntervalMs: resolved.approvalPollMs, log, signal: approvalAbort.signal },
    )
      .then(() => {
        metrics.approvalWatcherOutcomes += 1;
      })
      .catch((error: unknown) => {
        log({ event: 'approval_watch_failed', level: 'warn', errorClass: errorClassOf(error), runId: input.runId });
      });
    activeApprovalWatches.add(watch);
    void watch.then(
      () => activeApprovalWatches.delete(watch),
      () => activeApprovalWatches.delete(watch),
    );
  }

  async function onMessage(raw: unknown): Promise<void> {
    if (stopped) return;
    let message: NormalizedFeishuMessage;
    try {
      message = decodeReceivedMessage(raw);
    } catch (error) {
      log({ event: 'message_decode_failed', level: 'warn', errorClass: errorClassOf(error) });
      return;
    }

    let outcome;
    try {
      outcome = await handleIncomingMessage(
        message,
        { qm, feishu },
        { botOpenId: resolved.feishuBotOpenId, tenantKey: resolved.feishuTenantKey },
      );
    } catch (error) {
      log({ event: 'intake_failed', level: 'warn', errorClass: errorClassOf(error), messageId: message.messageId });
      return;
    }

    log({ event: 'intake_outcome', outcome: outcome.kind, messageId: message.messageId });
    if (outcome.kind !== 'accepted' || isStopped()) return;
    watchAcceptedApproval({ runId: outcome.runId, threadRef: outcome.threadRef, destination: outcome.destination });
  }

  async function onCardAction(raw: unknown): Promise<CardCallbackResponse> {
    if (stopped) return { toast: { type: 'error', content: 'This action could not be processed.' } };
    let action: NormalizedCardAction;
    try {
      action = decodeCardAction(raw);
    } catch (error) {
      log({ event: 'card_action_decode_failed', level: 'warn', errorClass: errorClassOf(error) });
      return { toast: { type: 'error', content: 'This action could not be processed.' } };
    }

    const { response, outcome } = await handleCardAction(action, { qm }, { log });
    log({ event: 'approval_action_outcome', outcome: outcome.kind, requestId: action.requestId });
    return response;
  }

  let tick: Promise<void> | undefined;
  async function lifecycleTick(): Promise<void> {
    if (stopped) return;
    try {
      log({ event: 'qm_probe_start', level: 'debug' });
      await qm.probe();
      if (isStopped()) return;
      log({ event: 'qm_probe_ok', level: 'debug' });
      log({ event: 'feishu_probe_start', level: 'debug' });
      await feishu.probe();
      if (isStopped()) return;
      log({ event: 'feishu_probe_ok', level: 'debug' });
      if (!eventSourceStarted) {
        await eventSource.start({ onMessage, onCardAction });
        if (isStopped()) {
          await eventSource.stop().catch(() => undefined);
          return;
        }
        eventSourceStarted = true;
      }
      await dispatcher.poll();
      if (!isStopped()) health.setReady(true);
    } catch (error) {
      health.setReady(false);
      log({ event: 'runtime_dependency_unavailable', level: 'warn', errorClass: errorClassOf(error) });
    }
  }

  function scheduleTick(): void {
    if (stopped || tick !== undefined) return;
    tick = lifecycleTick();
    void tick.then(
      () => { tick = undefined; },
      () => { tick = undefined; },
    );
  }

  await lifecycleTick();
  const lifecycleTimer = setInterval(scheduleTick, resolved.deliveryPollMs);
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= (async () => {
      stopped = true;
      health.setReady(false);
      clearInterval(lifecycleTimer);
      approvalAbort.abort();
      const pending = [...activeApprovalWatches, ...(tick ? [tick] : [])];
      const drain = Promise.allSettled([
        eventSource.stop(),
        Promise.allSettled(pending),
        dispatcher.stop(resolved.shutdownTimeoutMs),
      ]);
      await Promise.race([drain, delay(resolved.shutdownTimeoutMs)]);
      await health.stop().catch(() => undefined);
    })();
    return stopping;
  }

  return { stop };
}
