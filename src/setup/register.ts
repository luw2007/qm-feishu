import { registerApp as sdkRegisterApp } from '@larksuiteoapi/node-sdk';

import type { FeishuEventSource } from '../ports.js';

export const SETUP_SCOPES = [
  'im:message',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:message:send_as_bot',
  'im:resource',
  'im:chat:readonly',
] as const;

export const SETUP_EVENT = 'im.message.receive_v1';
export const SETUP_CALLBACK = 'card.action.trigger';

const ACCOUNTS_DOMAINS = {
  feishu: 'accounts.feishu.cn',
  lark: 'accounts.larksuite.com',
} as const;

export class FeishuRegistrationError extends Error {
  readonly code: string;
  constructor(code: string, cause?: unknown) {
    super(`Feishu application registration failed: ${code}`, { cause });
    this.name = 'FeishuRegistrationError';
    this.code = code;
  }
}

export class FeishuTenantDiscoveryError extends Error {
  constructor() {
    super('Timed out waiting for a Feishu message event');
    this.name = 'FeishuTenantDiscoveryError';
  }
}

export type RegisterApplicationOptions = {
  createOnly: true;
  domain?: string;
  source: string;
  appPreset?: { name?: string; desc?: string };
  addons: {
    preset: false;
    scopes: { tenant: string[] };
    events: { items: { tenant: string[] } };
    callbacks: { items: string[] };
  };
  onQRCodeReady(info: { url: string; expireIn: number }): void;
  onStatusChange?(info: { status: string; interval?: number }): void;
};

export type RegisterApplicationResult = {
  client_id?: string;
  client_secret?: string;
  user_info?: { tenant_brand?: string };
};

export type RegisterApplicationFn = (
  options: RegisterApplicationOptions,
) => Promise<RegisterApplicationResult>;

export type RegisteredFeishuApplication = {
  appId: string;
  appSecret: string;
  brand: 'feishu' | 'lark';
};

export async function registerFeishuApplication(options: {
  registerApp?: RegisterApplicationFn;
  brand?: 'feishu' | 'lark';
  appName?: string;
  writeLine: (line: string) => void;
}): Promise<RegisteredFeishuApplication> {
  const registerApp = options.registerApp ?? sdkRegisterApp;
  try {
    const result = await registerApp({
      ...(options.brand !== undefined ? { domain: ACCOUNTS_DOMAINS[options.brand] } : {}),
      createOnly: true,
      source: 'qm-feishu',
      ...(options.appName
        ? { appPreset: { name: options.appName, desc: 'QM Feishu message surface' } }
        : {}),
      addons: {
        preset: false,
        scopes: { tenant: [...SETUP_SCOPES] },
        events: { items: { tenant: [SETUP_EVENT] } },
        callbacks: { items: [SETUP_CALLBACK] },
      },
      onQRCodeReady: ({ url, expireIn }) => {
        options.writeLine(`Open this URL in Feishu/Lark to create the application (${expireIn}s):`);
        options.writeLine(url);
      },
      onStatusChange: ({ status, interval }) => {
        if (status === 'domain_switched') options.writeLine('Detected a Lark international tenant.');
        if (status === 'slow_down' && interval !== undefined) {
          options.writeLine(`Registration polling slowed to ${interval}s.`);
        }
      },
    });
    if (!result.client_id || !result.client_secret) {
      throw new Error('missing_credentials');
    }
    return {
      appId: result.client_id,
      appSecret: result.client_secret,
      brand: result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu',
    };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : error instanceof Error && error.message === 'missing_credentials'
          ? 'missing_credentials'
          : 'unknown';
    throw new FeishuRegistrationError(code, error);
  }
}

function tenantKeyFromEvent(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const tenantKey = (raw as { tenant_key?: unknown }).tenant_key;
  return typeof tenantKey === 'string' && tenantKey.length > 0 ? tenantKey : undefined;
}

export async function discoverTenantKey(options: {
  source: FeishuEventSource;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive integer');

  let resolveTenant!: (tenantKey: string) => void;
  let rejectTenant!: (error: Error) => void;
  const tenant = new Promise<string>((resolve, reject) => {
    resolveTenant = resolve;
    rejectTenant = reject;
  });
  const timer = setTimeout(() => {
    rejectTenant(new FeishuTenantDiscoveryError());
  }, timeoutMs);

  try {
    const started = options.source.start({
      onMessage: (event) => {
        const tenantKey = tenantKeyFromEvent(event);
        if (tenantKey) resolveTenant(tenantKey);
        return Promise.resolve();
      },
      onCardAction: () => Promise.resolve(undefined),
    });
    return await Promise.race([started.then(() => tenant), tenant]);
  } finally {
    clearTimeout(timer);
    await options.source.stop();
  }
}
