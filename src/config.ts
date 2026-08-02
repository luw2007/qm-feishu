export interface FeishuSurfaceConfig {
  coreApiUrl: string;
  coreSigningSecret: string;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuBotOpenId: string;
  feishuTenantKey: string;
  claimPrincipalDeliveries?: boolean;
  deliveryClaimMs?: number;
  deliveryPollMs?: number;
  approvalPollMs?: number;
  requestTimeoutMs?: number;
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

function port(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 65_535) {
    throw new Error(`${name} must be an integer between 0 and 65535`);
  }
  return resolved;
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function level(value: string | undefined, fallback: (typeof LOG_LEVELS)[number]): (typeof LOG_LEVELS)[number] {
  const resolved = value ?? fallback;
  if (!(LOG_LEVELS as readonly string[]).includes(resolved)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  }
  return resolved as (typeof LOG_LEVELS)[number];
}

export function resolveConfig(config: FeishuSurfaceConfig): ResolvedFeishuSurfaceConfig {
  const coreApiUrl = required(config.coreApiUrl, 'CORE_API_URL').replace(/\/+$/, '');
  const coreSigningSecret = required(config.coreSigningSecret, 'CORE_SIGNING_SECRET');
  if (coreSigningSecret.length < 32) throw new Error('CORE_SIGNING_SECRET must contain at least 32 characters');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(coreApiUrl);
  } catch {
    throw new Error('CORE_API_URL must be a valid HTTP or HTTPS URL');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error('CORE_API_URL must use HTTP or HTTPS');

  return {
    coreApiUrl,
    coreSigningSecret,
    feishuAppId: required(config.feishuAppId, 'FEISHU_APP_ID'),
    feishuAppSecret: required(config.feishuAppSecret, 'FEISHU_APP_SECRET'),
    feishuBotOpenId: required(config.feishuBotOpenId, 'FEISHU_BOT_OPEN_ID'),
    feishuTenantKey: required(config.feishuTenantKey, 'FEISHU_TENANT_KEY'),
    claimPrincipalDeliveries: config.claimPrincipalDeliveries ?? false,
    deliveryClaimMs: positive(config.deliveryClaimMs, 30_000, 'deliveryClaimMs'),
    deliveryPollMs: positive(config.deliveryPollMs, 1_000, 'deliveryPollMs'),
    approvalPollMs: positive(config.approvalPollMs, 1_000, 'approvalPollMs'),
    requestTimeoutMs: positive(config.requestTimeoutMs, 10_000, 'requestTimeoutMs'),
    shutdownTimeoutMs: positive(config.shutdownTimeoutMs, 15_000, 'shutdownTimeoutMs'),
    healthHost: config.healthHost ?? '127.0.0.1',
    healthPort: port(config.healthPort, 3000, 'healthPort'),
    logLevel: level(config.logLevel, 'info'),
  };
}

function numField<K extends string>(key: K, value: string | undefined): { [P in K]?: number } {
  if (value === undefined) return {};
  const parsed = Number(value);
  return { [key]: Number.isFinite(parsed) ? parsed : NaN } as { [P in K]?: number };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): FeishuSurfaceConfig {
  return {
    coreApiUrl: env.CORE_API_URL ?? '',
    coreSigningSecret: env.CORE_SIGNING_SECRET ?? '',
    feishuAppId: env.FEISHU_APP_ID ?? '',
    feishuAppSecret: env.FEISHU_APP_SECRET ?? '',
    feishuBotOpenId: env.FEISHU_BOT_OPEN_ID ?? '',
    feishuTenantKey: env.FEISHU_TENANT_KEY ?? '',
    claimPrincipalDeliveries: env.FEISHU_CLAIM_PRINCIPAL_DELIVERIES === '1',
    ...numField('deliveryClaimMs', env.FEISHU_DELIVERY_CLAIM_MS),
    ...numField('deliveryPollMs', env.FEISHU_DELIVERY_POLL_MS),
    ...numField('approvalPollMs', env.FEISHU_APPROVAL_POLL_MS),
    ...numField('requestTimeoutMs', env.CORE_REQUEST_TIMEOUT_MS),
    ...numField('shutdownTimeoutMs', env.FEISHU_SHUTDOWN_TIMEOUT_MS),
    ...(env.HEALTH_HOST !== undefined ? { healthHost: env.HEALTH_HOST } : {}),
    ...numField('healthPort', env.HEALTH_PORT),
    ...(env.LOG_LEVEL !== undefined ? { logLevel: env.LOG_LEVEL as (typeof LOG_LEVELS)[number] } : {}),
  } satisfies FeishuSurfaceConfig;
}
