import type {
  ApprovalView,
  BlobRef,
  Delivery,
  DeliveryReceipt,
  DirectoryBatch,
  FeishuResourceKey,
  FeishuTarget,
  IncomingFile,
  IncomingResource,
  MessageReceipt,
  OutgoingFile,
  OutgoingMessage,
  QueuedRun,
  RunView,
  SurfaceEvent,
  SurfaceTurn,
} from './types.js';

export interface QmPort {
  probe(): Promise<void>;
  submitTurn(input: SurfaceTurn): Promise<QueuedRun>;
  getRun(runId: string): Promise<RunView>;
  activeRun(threadRef: string): Promise<string | undefined>;
  signalRun(runId: string, signal: { kind: 'abort' | 'steer'; text?: string }): Promise<void>;
  claimDeliveries(type: string, leaseMs: number): Promise<Delivery[]>;
  ackDelivery(id: string, receipt?: DeliveryReceipt): Promise<void>;
  ackDeliveryByKey(idempotencyKey: string): Promise<void>;
  pendingApproval(threadRef: string): Promise<ApprovalView | null>;
  getApproval(requestId: string): Promise<ApprovalView | null>;
  stageBlob(file: IncomingFile): Promise<BlobRef>;
  readBlob(blobId: string): Promise<ReadableStream<Uint8Array>>;
  readFileArtifact(artifactId: string, viewerId: string): Promise<ReadableStream<Uint8Array>>;
  pushDirectory(batch: DirectoryBatch): Promise<void>;
  ingestSurfaceEvents(events: SurfaceEvent[]): Promise<void>;
}

export interface FeishuPort {
  probe(): Promise<void>;
  reply(messageId: string, message: OutgoingMessage): Promise<MessageReceipt>;
  send(target: FeishuTarget, message: OutgoingMessage): Promise<MessageReceipt>;
  update(messageId: string, message: OutgoingMessage): Promise<void>;
  download(resource: IncomingResource): Promise<ReadableStream<Uint8Array>>;
  upload(file: OutgoingFile): Promise<FeishuResourceKey>;
}

export interface FeishuEventSource {
  start(handlers: {
    onMessage(event: unknown): Promise<void>;
    onCardAction(event: unknown): Promise<unknown>;
  }): Promise<void>;
  stop(): Promise<void>;
}
