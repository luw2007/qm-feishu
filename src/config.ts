export interface FeishuSurfaceConfig {
  coreApiUrl: string;
  coreSigningSecret: string;
  feishuAppId: string;
  feishuAppSecret: string;
  claimPrincipalDeliveries?: boolean;
  deliveryClaimMs?: number;
  deliveryPollMs?: number;
  approvalPollMs?: number;
  requestTimeoutMs?: number;
  retryCount?: number;
  shutdownTimeoutMs?: number;
  healthHost?: string;
  healthPort?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export type ResolvedFeishuSurfaceConfig = Required<FeishuSurfaceConfig>;

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive integer`);
  return resolved;
}

export function resolveConfig(config: FeishuSurfaceConfig): ResolvedFeishuSurfaceConfig {
  const coreApiUrl = required(config.coreApiUrl, 'CORE_API_URL').replace(/\/+$/, '');
  const coreSigningSecret = required(config.coreSigningSecret, 'CORE_SIGNING_SECRET');
  if (coreSigningSecret.length < 32) throw new Error('CORE_SIGNING_SECRET must contain at least 32 characters');
  const parsedUrl = new URL(coreApiUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error('CORE_API_URL must use HTTP or HTTPS');

  return {
    coreApiUrl,
    coreSigningSecret,
    feishuAppId: required(config.feishuAppId, 'FEISHU_APP_ID'),
    feishuAppSecret: required(config.feishuAppSecret, 'FEISHU_APP_SECRET'),
    claimPrincipalDeliveries: config.claimPrincipalDeliveries ?? false,
    deliveryClaimMs: positive(config.deliveryClaimMs, 30_000, 'deliveryClaimMs'),
    deliveryPollMs: positive(config.deliveryPollMs, 1_000, 'deliveryPollMs'),
    approvalPollMs: positive(config.approvalPollMs, 1_000, 'approvalPollMs'),
    requestTimeoutMs: positive(config.requestTimeoutMs, 10_000, 'requestTimeoutMs'),
    retryCount: positive(config.retryCount, 3, 'retryCount'),
    shutdownTimeoutMs: positive(config.shutdownTimeoutMs, 15_000, 'shutdownTimeoutMs'),
    healthHost: config.healthHost ?? '127.0.0.1',
    healthPort: positive(config.healthPort, 3000, 'healthPort'),
    logLevel: config.logLevel ?? 'info',
  };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): FeishuSurfaceConfig {
  return {
    coreApiUrl: env.CORE_API_URL ?? '',
    coreSigningSecret: env.CORE_SIGNING_SECRET ?? '',
    feishuAppId: env.FEISHU_APP_ID ?? '',
    feishuAppSecret: env.FEISHU_APP_SECRET ?? '',
    claimPrincipalDeliveries: env.FEISHU_CLAIM_PRINCIPAL_DELIVERIES === '1',
  };
}
