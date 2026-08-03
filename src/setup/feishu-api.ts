export type FeishuBrand = 'feishu' | 'lark';

const FEISHU_OPEN_API_HOSTS: Record<FeishuBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

export function feishuOpenApiHost(brand: FeishuBrand): string {
  return FEISHU_OPEN_API_HOSTS[brand];
}

export class FeishuSetupAuthError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`Feishu rejected the credentials with code ${code}`);
    this.name = 'FeishuSetupAuthError';
    this.code = code;
  }
}

export class FeishuSetupNetworkError extends Error {
  constructor() {
    super('Feishu setup request failed before receiving an HTTP response');
    this.name = 'FeishuSetupNetworkError';
  }
}

export class FeishuSetupTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Feishu setup request timed out after ${timeoutMs}ms`);
    this.name = 'FeishuSetupTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class FeishuSetupConfigError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`Feishu rejected the application configuration with code ${code}`);
    this.name = 'FeishuSetupConfigError';
    this.code = code;
  }
}

export class FeishuSetupContractError extends Error {
  constructor(reason: string) {
    super(`Feishu setup response was malformed: ${reason}`);
    this.name = 'FeishuSetupContractError';
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export type FeishuSetupCredentials = {
  appId: string;
  appSecret: string;
};

export type FeishuTenantAccessToken = {
  tenantAccessToken: string;
  expiresInSeconds: number;
};

function decodeTenantAccessToken(value: unknown): FeishuTenantAccessToken {
  if (!isObject(value) || typeof value.code !== 'number') throw new FeishuSetupContractError('missing code');
  if (value.code !== 0) throw new FeishuSetupAuthError(value.code);
  if (!nonEmptyString(value.tenant_access_token) || !finitePositive(value.expire)) {
    throw new FeishuSetupContractError('missing tenant_access_token or expire');
  }
  return { tenantAccessToken: value.tenant_access_token, expiresInSeconds: value.expire };
}

export type FeishuBotInfo = {
  openId: string;
  tenantKey?: string;
};

function decodeBotInfo(value: unknown): FeishuBotInfo {
  if (!isObject(value) || !isObject(value.bot)) throw new FeishuSetupContractError('missing bot object');
  const bot = value.bot;
  if (!nonEmptyString(bot.open_id)) throw new FeishuSetupContractError('missing bot.open_id');
  if (bot.tenant_key !== undefined && !nonEmptyString(bot.tenant_key)) {
    throw new FeishuSetupContractError('invalid bot.tenant_key');
  }
  return {
    openId: bot.open_id,
    ...(nonEmptyString(bot.tenant_key) ? { tenantKey: bot.tenant_key } : {}),
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new FeishuSetupContractError('response was not JSON');
  }
}

export type FeishuSetupApiOptions = {
  brand?: FeishuBrand;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

export class FeishuSetupApi {
  readonly #host: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: FeishuSetupApiOptions = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new TypeError('Feishu setup request timeout must be a positive integer');
    }
    this.#host = feishuOpenApiHost(options.brand ?? 'feishu');
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException('timed out', 'TimeoutError'));
    }, this.#requestTimeoutMs);
    try {
      return await this.#fetch(`${this.#host}${path}`, { ...init, redirect: 'error', signal: controller.signal });
    } catch {
      if (controller.signal.aborted) throw new FeishuSetupTimeoutError(this.#requestTimeoutMs);
      throw new FeishuSetupNetworkError();
    } finally {
      clearTimeout(timer);
    }
  }

  async exchangeTenantAccessToken(credentials: FeishuSetupCredentials): Promise<FeishuTenantAccessToken> {
    if (!credentials.appId) throw new TypeError('Feishu app ID is required');
    if (!credentials.appSecret) throw new TypeError('Feishu app secret is required');
    const response = await this.#request('/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
    });
    return decodeTenantAccessToken(await readJson(response));
  }

  async configureApplication(appId: string, tenantAccessToken: string): Promise<void> {
    if (!appId) throw new TypeError('Feishu app ID is required');
    if (!tenantAccessToken) throw new TypeError('Feishu tenant access token is required');
    const response = await this.#request(
      `/open-apis/application/v7/applications/${encodeURIComponent(appId)}/config`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${tenantAccessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          scope: {
            add_scopes: FEISHU_SETUP_MANIFEST.scopes.map((scopeName) => ({
              scope_name: scopeName,
              token_type: 'tenant',
            })),
          },
          event: {
            subscription_type: 'websocket',
            add_events: [FEISHU_SETUP_MANIFEST.event],
          },
          callback: {
            callback_type: 'websocket',
            add_callbacks: [FEISHU_SETUP_MANIFEST.callback],
          },
        }),
      },
    );
    const body = await readJson(response);
    if (!isObject(body) || typeof body.code !== 'number') {
      throw new FeishuSetupContractError('missing application configuration code');
    }
    if (body.code !== 0) throw new FeishuSetupConfigError(body.code);
  }

  async probeBotInfo(tenantAccessToken: string): Promise<FeishuBotInfo> {
    if (!tenantAccessToken) throw new TypeError('Feishu tenant access token is required');
    const response = await this.#request('/open-apis/bot/v3/info/', {
      method: 'GET',
      headers: { authorization: `Bearer ${tenantAccessToken}` },
    });
    return decodeBotInfo(await readJson(response));
  }
}

export type FeishuSetupManifest = {
  scopes: readonly string[];
  event: string;
  callback: string;
  mode: 'long-connection';
};

export const FEISHU_SETUP_MANIFEST: FeishuSetupManifest = {
  scopes: [
    'im:message',
    'im:message.p2p_msg:readonly',
    'im:message.group_at_msg:readonly',
    'im:message:send_as_bot',
    'im:resource',
    'im:chat:readonly',
  ],
  event: 'im.message.receive_v1',
  callback: 'card.action.trigger',
  mode: 'long-connection',
};

