import { FeishuLongConnectionError, FeishuSdkEventSource } from './feishu/events.js';
import { HELP_TEXT, parseArgs, SetupArgsError } from './setup/args.js';
import { DotenvValueError, persistDotenvFile } from './setup/config-file.js';
import {
  FeishuSetupAuthError,
  FeishuSetupConfigError,
  FeishuSetupContractError,
  FeishuSetupNetworkError,
  FeishuSetupTimeoutError,
  FeishuSetupApi,
  feishuOpenApiHost,
} from './setup/feishu-api.js';
import {
  FeishuRegistrationError,
  FeishuTenantDiscoveryError,
  registerFeishuApplication,
} from './setup/register.js';
import { runSetup, SetupError } from './setup/setup.js';

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function safeErrorMessage(error: unknown): string {
  if (
    error instanceof SetupError ||
    error instanceof SetupArgsError ||
    error instanceof DotenvValueError ||
    error instanceof FeishuLongConnectionError ||
    error instanceof FeishuSetupAuthError ||
    error instanceof FeishuSetupConfigError ||
    error instanceof FeishuSetupContractError ||
    error instanceof FeishuSetupNetworkError ||
    error instanceof FeishuSetupTimeoutError ||
    error instanceof FeishuRegistrationError ||
    error instanceof FeishuTenantDiscoveryError
  ) {
    return error.message;
  }
  return `Setup failed: ${error instanceof Error ? error.name : 'UnknownError'}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  await runSetup(args, {
    env: process.env,
    cwd: process.cwd(),
    writeLine,
    registerApplication: registerFeishuApplication,
    createApi: (brand) => new FeishuSetupApi({ brand }),
    createEventSource: ({ appId, appSecret, brand }) =>
      new FeishuSdkEventSource({
        appId,
        appSecret,
        domain: feishuOpenApiHost(brand),
        awaitReady: true,
      }),
    persist: persistDotenvFile,
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
