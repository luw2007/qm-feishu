export type Brand = 'feishu' | 'lark';

export interface SetupArgs {
  help: boolean;
  openPlatformAuto: boolean;
  appId?: string;
  appSecret?: string;
  tenantKey?: string;
  coreApiUrl?: string;
  coreSigningSecret?: string;
  envFile?: string;
  brand?: Brand;
}

export class SetupArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupArgsError';
  }
}

const KNOWN_VALUE_FLAGS = new Set([
  '--app-id',
  '--app-secret',
  '--tenant-key',
  '--core-api-url',
  '--core-signing-secret',
  '--env-file',
  '--brand',
]);

export const HELP_TEXT = `Usage: qm-feishu setup [options]

Options:
  --app-id <id>                    Feishu/Lark application ID
  --app-secret <secret>            Feishu/Lark application secret
  --tenant-key <key>               Feishu/Lark tenant key
  --core-api-url <url>             QM core API URL
  --core-signing-secret <secret>   QM core signing secret
  --env-file <path>                Path to the .env file to update
  --brand <feishu|lark>            Target brand
  --no-open-platform-auto          Disable automatic open platform identity lookup
  --help, -h                       Show this help message
`;

export function parseArgs(argv: readonly string[]): SetupArgs {
  let help = false;
  let openPlatformAuto = true;
  let appId: string | undefined;
  let appSecret: string | undefined;
  let tenantKey: string | undefined;
  let coreApiUrl: string | undefined;
  let coreSigningSecret: string | undefined;
  let envFile: string | undefined;
  let brand: Brand | undefined;

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) break;

    if (token === '--help' || token === '-h') {
      help = true;
      i += 1;
      continue;
    }

    if (token === '--no-open-platform-auto') {
      openPlatformAuto = false;
      i += 1;
      continue;
    }

    const eqIndex = token.indexOf('=');
    const flag = eqIndex === -1 ? token : token.slice(0, eqIndex);

    if (!KNOWN_VALUE_FLAGS.has(flag)) {
      const label = flag.startsWith('-') ? flag : 'positional argument';
      throw new SetupArgsError(`Unknown argument: ${label}`);
    }

    let value: string;
    if (eqIndex !== -1) {
      value = token.slice(eqIndex + 1);
      i += 1;
    } else {
      const next = argv[i + 1];
      if (next === undefined) throw new SetupArgsError(`${flag} requires a value`);
      value = next;
      i += 2;
    }

    if (value.length === 0) throw new SetupArgsError(`${flag} must not be empty`);

    switch (flag) {
      case '--app-id':
        appId = value;
        break;
      case '--app-secret':
        appSecret = value;
        break;
      case '--tenant-key':
        tenantKey = value;
        break;
      case '--core-api-url':
        coreApiUrl = value;
        break;
      case '--core-signing-secret':
        coreSigningSecret = value;
        break;
      case '--env-file':
        envFile = value;
        break;
      case '--brand':
        if (value !== 'feishu' && value !== 'lark') throw new SetupArgsError('--brand must be "feishu" or "lark"');
        brand = value;
        break;
    }
  }

  return {
    help,
    openPlatformAuto,
    ...(appId !== undefined ? { appId } : {}),
    ...(appSecret !== undefined ? { appSecret } : {}),
    ...(tenantKey !== undefined ? { tenantKey } : {}),
    ...(coreApiUrl !== undefined ? { coreApiUrl } : {}),
    ...(coreSigningSecret !== undefined ? { coreSigningSecret } : {}),
    ...(envFile !== undefined ? { envFile } : {}),
    ...(brand !== undefined ? { brand } : {}),
  };
}
