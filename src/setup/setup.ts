import path from 'node:path';

import type { FeishuEventSource } from '../ports.js';
import type { SetupArgs } from './args.js';
import type { ManagedKey } from './config-file.js';
import type {
  FeishuBotInfo,
  FeishuBrand,
  FeishuSetupCredentials,
  FeishuTenantAccessToken,
} from './feishu-api.js';
import { discoverTenantKey, type RegisteredFeishuApplication } from './register.js';

export class SetupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SetupError';
    this.code = code;
  }
}

type SetupApi = {
  exchangeTenantAccessToken(credentials: FeishuSetupCredentials): Promise<FeishuTenantAccessToken>;
  probeBotInfo(tenantAccessToken: string): Promise<FeishuBotInfo>;
  configureApplication(appId: string, tenantAccessToken: string): Promise<void>;
};

export type SetupDependencies = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  writeLine(line: string): void;
  registerApplication(options: {
    appName?: string;
    brand?: FeishuBrand;
    writeLine(line: string): void;
  }): Promise<RegisteredFeishuApplication>;
  createApi(brand: FeishuBrand): SetupApi;
  createEventSource(options: {
    appId: string;
    appSecret: string;
    brand: FeishuBrand;
  }): FeishuEventSource;
  persist(filePath: string, updates: Partial<Record<ManagedKey, string>>): Promise<void>;
  tenantDiscoveryTimeoutMs?: number;
};

export type SetupResult = {
  envFile: string;
  brand: FeishuBrand;
};

function requiredCoreConfig(args: SetupArgs, env: NodeJS.ProcessEnv): {
  coreApiUrl: string;
  coreSigningSecret: string;
} {
  const rawUrl = args.coreApiUrl ?? env.CORE_API_URL ?? '';
  const coreSigningSecret = (args.coreSigningSecret ?? env.CORE_SIGNING_SECRET ?? '').trim();
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new SetupError('invalid_core_config', 'CORE_API_URL must be a valid HTTP or HTTPS URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SetupError('invalid_core_config', 'CORE_API_URL must use HTTP or HTTPS');
  }
  if (coreSigningSecret.length < 32) {
    throw new SetupError('invalid_core_config', 'CORE_SIGNING_SECRET must contain at least 32 characters');
  }
  return { coreApiUrl: rawUrl.trim().replace(/\/+$/, ''), coreSigningSecret };
}

function suppliedCredentials(args: SetupArgs, env: NodeJS.ProcessEnv): FeishuSetupCredentials | undefined {
  const appId = (args.appId ?? env.FEISHU_APP_ID ?? '').trim();
  const appSecret = (args.appSecret ?? env.FEISHU_APP_SECRET ?? '').trim();
  if ((appId.length === 0) !== (appSecret.length === 0)) {
    throw new SetupError('incomplete_credentials', 'Feishu app ID and app secret must be supplied together');
  }
  return appId && appSecret ? { appId, appSecret } : undefined;
}

export async function runSetup(args: SetupArgs, dependencies: SetupDependencies): Promise<SetupResult> {
  const core = requiredCoreConfig(args, dependencies.env);
  const explicitCredentials = suppliedCredentials(args, dependencies.env);
  if (!explicitCredentials && !args.openPlatformAuto) {
    throw new SetupError('credentials_required', 'Feishu app credentials are required when Open Platform automation is disabled');
  }

  const requestedBrand = args.brand ?? 'feishu';
  const registered = explicitCredentials
    ? { ...explicitCredentials, brand: requestedBrand }
    : await dependencies.registerApplication({
        appName: 'qm-feishu',
        ...(args.brand !== undefined ? { brand: args.brand } : {}),
        writeLine: (line) => {
          dependencies.writeLine(line);
        },
      });
  const brand = explicitCredentials ? requestedBrand : registered.brand;
  const api = dependencies.createApi(brand);
  const token = await api.exchangeTenantAccessToken({
    appId: registered.appId,
    appSecret: registered.appSecret,
  });
  if (explicitCredentials && args.openPlatformAuto) {
    await api.configureApplication(registered.appId, token.tenantAccessToken);
  }
  const bot = await api.probeBotInfo(token.tenantAccessToken);

  const explicitTenantKey = (args.tenantKey ?? dependencies.env.FEISHU_TENANT_KEY ?? '').trim() || undefined;
  let tenantKey: string;
  if (bot.tenantKey) {
    if (explicitTenantKey && explicitTenantKey !== bot.tenantKey) {
      throw new SetupError('tenant_mismatch', 'The supplied tenant key does not match the verified Feishu bot tenant');
    }
    tenantKey = bot.tenantKey;
  } else {
    dependencies.writeLine('Send the bot a test message to verify long-connection delivery and identify the tenant.');
    const discoveredTenantKey = await discoverTenantKey({
      source: dependencies.createEventSource({
        appId: registered.appId,
        appSecret: registered.appSecret,
        brand,
      }),
      ...(dependencies.tenantDiscoveryTimeoutMs !== undefined
        ? { timeoutMs: dependencies.tenantDiscoveryTimeoutMs }
        : {}),
    });
    if (explicitTenantKey && explicitTenantKey !== discoveredTenantKey) {
      throw new SetupError('tenant_mismatch', 'The supplied tenant key does not match the verified Feishu event tenant');
    }
    tenantKey = discoveredTenantKey;
  }

  const envFile = path.resolve(dependencies.cwd, args.envFile ?? '.env');
  await dependencies.persist(envFile, {
    CORE_API_URL: core.coreApiUrl,
    CORE_SIGNING_SECRET: core.coreSigningSecret,
    FEISHU_APP_ID: registered.appId,
    FEISHU_APP_SECRET: registered.appSecret,
    FEISHU_BOT_OPEN_ID: bot.openId,
    FEISHU_TENANT_KEY: tenantKey,
    FEISHU_BRAND: brand,
  });
  dependencies.writeLine(`Setup complete. Runtime configuration written to ${path.relative(dependencies.cwd, envFile) || '.env'}.`);
  return { envFile, brand };
}
