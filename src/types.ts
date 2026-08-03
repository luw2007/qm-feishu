export type FeishuActor = {
  externalId: string;
  displayName?: string;
};

export type FeishuConversation = {
  id: string;
  kind: 'dm' | 'group';
  name?: string;
};

export type IncomingFile = {
  bytes: Uint8Array;
  filename: string;
  mediaType: string;
  sha256: string;
};

export type BlobRef = {
  blobId: string;
  sizeBytes: number;
};

export type SurfaceAttachment = {
  blobId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
};

export type SurfaceTurn = {
  text: string;
  actor: FeishuActor;
  conversation: FeishuConversation;
  threadRef: string;
  destination: string;
  surface: 'feishu';
  addressed: true;
  surfaceTools: false;
  idempotencyKey: string;
  origin: {
    kind: 'human';
    messageTs: string;
  };
  triggerTs: number;
  displayText: string;
  attachments?: SurfaceAttachment[];
  approval?: {
    requestId: string;
    approved: boolean;
    scope?: ApprovalScope;
  };
};

export type QueuedRun = {
  runId: string;
  queued: true;
  steered?: boolean;
};

export type TurnSubmission = QueuedRun | { replayed: true };

export type RunView = {
  runId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted';
};

export type ApprovalScope = 'once' | 'session' | 'always';

export type ApprovalView = {
  requestId: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  command?: string;
  grantModes: {
    once: boolean;
    session: boolean;
    always: boolean;
  };
  request?: {
    actor: FeishuActor;
    surface?: string;
    deliveryTarget?: string;
    conversation?: {
      kind: 'dm' | 'group';
      threadRef: string;
      channelRef: string;
    };
  };
};

export type DeliveryAttachment = {
  kind: 'blob' | 'file';
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes?: number;
  viewerId?: string;
};

export type Delivery = {
  id: string;
  idempotencyKey: string;
  type: 'feishu' | 'principal' | (string & {});
  target: string;
  text: string;
  shadow?: boolean;
  attachments?: DeliveryAttachment[];
};

export type DeliveryReceipt = {
  threadRef?: string;
  messageIds?: string[];
};

export type DirectoryBatch = {
  members?: Array<{
    principalId: string;
    displayName?: string;
    active?: boolean;
  }>;
  channels?: Array<{
    id: string;
    name?: string;
  }>;
};

export type SurfaceEvent = {
  container: string;
  ts: string;
  threadTs?: string;
  actorId?: string;
  text?: string;
  files?: Array<{
    fileId: string;
    name?: string;
    mediaType?: string;
    sizeBytes?: number;
  }>;
};

export type FeishuTarget =
  | { kind: 'reply'; chatId: string; messageId: string }
  | { kind: 'user'; openId: string };

export type OutgoingMessage =
  | { kind: 'text'; text: string; uuid: string }
  | { kind: 'card'; card: Record<string, unknown>; uuid: string }
  | { kind: 'image'; imageKey: string; uuid: string }
  | { kind: 'file'; fileKey: string; uuid: string };

export type MessageReceipt = {
  messageId: string;
  chatId?: string;
};

export type IncomingResource = {
  messageId: string;
  resourceKey: string;
  kind: 'image' | 'file';
};

export type OutgoingFile = {
  bytes: Uint8Array;
  filename: string;
  mediaType: string;
  kind: 'image' | 'file';
};

export type FeishuResourceKey = {
  kind: 'image' | 'file';
  key: string;
};

export type NormalizedFeishuMessage = {
  eventId: string;
  tenantKey?: string;
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  messageType: 'text' | 'post' | 'image' | 'file';
  senderOpenId: string;
  senderType: string;
  createTime: number;
  rootId?: string;
  threadId?: string;
  text: string;
  mentions: string[];
  resource?: {
    key: string;
    filename?: string;
    mediaType?: string;
  };
};

export type NormalizedCardAction = {
  eventId: string;
  operatorOpenId: string;
  requestId: string;
  action: 'allow_once' | 'allow_session' | 'allow_always' | 'deny';
};
