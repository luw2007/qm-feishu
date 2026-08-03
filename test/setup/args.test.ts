import assert from 'node:assert/strict';
import test from 'node:test';

import { HELP_TEXT, parseArgs, SetupArgsError } from '../../src/setup/args.ts';

void test('parseArgs captures every documented flag', () => {
  const args = parseArgs([
    '--app-id',
    'cli_test_app',
    '--app-secret',
    'secret_test',
    '--tenant-key',
    'tenant_test_1',
    '--core-api-url',
    'http://127.0.0.1:18080',
    '--core-signing-secret',
    'x'.repeat(32),
    '--env-file',
    '/tmp/example.env',
    '--brand',
    'lark',
  ]);
  assert.deepEqual(args, {
    help: false,
    openPlatformAuto: true,
    appId: 'cli_test_app',
    appSecret: 'secret_test',
    tenantKey: 'tenant_test_1',
    coreApiUrl: 'http://127.0.0.1:18080',
    coreSigningSecret: 'x'.repeat(32),
    envFile: '/tmp/example.env',
    brand: 'lark',
  });
});

void test('parseArgs supports --flag=value form', () => {
  const args = parseArgs(['--brand=feishu', '--app-id=cli_x']);
  assert.equal(args.brand, 'feishu');
  assert.equal(args.appId, 'cli_x');
});

void test('parseArgs defaults openPlatformAuto to true and flips it off', () => {
  assert.equal(parseArgs([]).openPlatformAuto, true);
  assert.equal(parseArgs(['--no-open-platform-auto']).openPlatformAuto, false);
});

void test('parseArgs recognizes --help and -h', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs([]).help, false);
});

void test('parseArgs leaves optional fields absent when not provided', () => {
  const args = parseArgs([]);
  assert.equal('appId' in args, false);
  assert.equal('appSecret' in args, false);
  assert.equal('brand' in args, false);
  assert.equal('envFile' in args, false);
});

void test('parseArgs rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--bogus', 'x']), SetupArgsError);
  assert.throws(() => parseArgs(['--bogus', 'x']), /Unknown argument: --bogus/);
});

void test('parseArgs rejects a stray positional argument without echoing its value', () => {
  const secret = 'super-secret-positional-value';
  assert.throws(
    () => parseArgs([secret]),
    (error: unknown) => {
      assert.ok(error instanceof SetupArgsError);
      assert.ok(!(error as Error).message.includes(secret));
      return true;
    },
  );
});

void test('parseArgs rejects a flag missing its value', () => {
  assert.throws(() => parseArgs(['--app-secret']), /--app-secret requires a value/);
  assert.throws(() => parseArgs(['--core-signing-secret']), /--core-signing-secret requires a value/);
});

void test('parseArgs rejects an empty value', () => {
  assert.throws(() => parseArgs(['--app-secret', '']), /--app-secret must not be empty/);
});

void test('parseArgs rejects an invalid --brand value', () => {
  assert.throws(() => parseArgs(['--brand', 'discord']), /--brand must be "feishu" or "lark"/);
});

void test('parseArgs never leaks secret values in thrown error messages', () => {
  const secret = 'sk-extremely-sensitive-token-value';
  try {
    parseArgs(['--brand', secret]);
    assert.fail('expected parseArgs to throw');
  } catch (error) {
    assert.ok(error instanceof SetupArgsError);
    assert.ok(!(error as Error).message.includes(secret));
  }

  try {
    parseArgs(['--app-secret', secret, '--tenant-key']);
    assert.fail('expected parseArgs to throw');
  } catch (error) {
    assert.ok(error instanceof SetupArgsError);
    assert.ok(!(error as Error).message.includes(secret));
  }
});

void test('HELP_TEXT documents every flag', () => {
  for (const flag of [
    '--app-id',
    '--app-secret',
    '--tenant-key',
    '--core-api-url',
    '--core-signing-secret',
    '--env-file',
    '--brand',
    '--no-open-platform-auto',
    '--help',
  ]) {
    assert.ok(HELP_TEXT.includes(flag), `expected HELP_TEXT to document ${flag}`);
  }
});
