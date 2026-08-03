import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DotenvValueError,
  MANAGED_KEYS,
  parseDotenvLines,
  persistDotenvFile,
  quoteDotenvValue,
  renderDotenvLines,
  updateDotenvContent,
  updateDotenvLines,
} from '../../src/setup/config-file.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qm-feishu-setup-'));
}

function unquoteForTest(quoted: string): string {
  assert.ok(quoted.startsWith('"') && quoted.endsWith('"'), `expected a quoted value, got ${quoted}`);
  const inner = quoted.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '\\' && i + 1 < inner.length) {
      const escaped = inner[i + 1];
      assert.ok(escaped !== undefined);
      out += escaped;
      i += 1;
    } else {
      const current = inner[i];
      assert.ok(current !== undefined);
      out += current;
    }
  }
  return out;
}

void test('MANAGED_KEYS lists exactly the seven managed keys', () => {
  assert.deepEqual(
    [...MANAGED_KEYS].sort(),
    [
      'CORE_API_URL',
      'CORE_SIGNING_SECRET',
      'FEISHU_APP_ID',
      'FEISHU_APP_SECRET',
      'FEISHU_BOT_OPEN_ID',
      'FEISHU_TENANT_KEY',
      'FEISHU_BRAND',
    ].sort(),
  );
});

void test('parseDotenvLines/renderDotenvLines round-trips comments, blanks, and unknown keys', () => {
  const content = ['# comment', '', 'FOO=bar', 'HEALTH_PORT=3000', ''].join('\n') + '\n';
  const lines = parseDotenvLines(content);
  assert.equal(renderDotenvLines(lines), content);
});

void test('updateDotenvLines replaces an existing managed key in place', () => {
  const lines = parseDotenvLines('CORE_API_URL="http://old"\n');
  const updated = updateDotenvLines(lines, { CORE_API_URL: 'http://new' });
  assert.equal(renderDotenvLines(updated), 'CORE_API_URL="http://new"\n');
});

void test('updateDotenvContent replaces an existing managed key while preserving surrounding lines', () => {
  const content = 'CORE_API_URL="http://old"\nFOO=bar\n';
  const updated = updateDotenvContent(content, { CORE_API_URL: 'http://new' });
  assert.equal(updated, 'CORE_API_URL="http://new"\nFOO=bar\n');
});

void test('updateDotenvContent appends missing managed keys in canonical order', () => {
  const updated = updateDotenvContent('', {
    FEISHU_TENANT_KEY: 'tenant',
    CORE_API_URL: 'http://x',
  });
  assert.equal(updated, 'CORE_API_URL="http://x"\nFEISHU_TENANT_KEY="tenant"\n');
});

void test('updateDotenvContent drops duplicate managed key lines and keeps a single updated entry', () => {
  const content = 'FEISHU_APP_ID=old1\nFEISHU_APP_ID=old2\n';
  const updated = updateDotenvContent(content, { FEISHU_APP_ID: 'new' });
  assert.equal(updated, 'FEISHU_APP_ID="new"\n');
});

void test('updateDotenvContent preserves unrelated optional settings, comments, and blank lines untouched', () => {
  const content = '# my config\n\nHEALTH_PORT=3000\nLOG_LEVEL=debug\n';
  const updated = updateDotenvContent(content, { CORE_API_URL: 'http://x' });
  assert.equal(updated, '# my config\n\nHEALTH_PORT=3000\nLOG_LEVEL=debug\nCORE_API_URL="http://x"\n');
});

void test('quoteDotenvValue round-trips values containing quotes, backslashes, and shell-special characters', () => {
  for (const value of [
    'plain',
    'has space',
    'say "hi"',
    'back\\slash',
    'mix "of" \\both\\',
    '#comment-looking',
    '$SHELL and `backtick`',
  ]) {
    const quoted = quoteDotenvValue(value);
    assert.equal(unquoteForTest(quoted), value);
  }
});

void test('quoteDotenvValue rejects newline characters', () => {
  assert.throws(() => quoteDotenvValue('line1\nline2'), DotenvValueError);
  assert.throws(() => quoteDotenvValue('line1\rline2'), DotenvValueError);
});

void test('quoteDotenvValue rejects NUL characters', () => {
  assert.throws(() => quoteDotenvValue('a\0b'), DotenvValueError);
});

void test('updateDotenvContent error messages never include the rejected secret value', () => {
  const secret = 'top-secret\nvalue';
  try {
    updateDotenvContent('', { CORE_SIGNING_SECRET: secret });
    assert.fail('expected updateDotenvContent to throw');
  } catch (error) {
    assert.ok(error instanceof DotenvValueError);
    assert.ok(!(error as Error).message.includes(secret));
  }
});

void test('persistDotenvFile creates the parent directory and writes with mode 0600', async () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'nested', '.env');
    await persistDotenvFile(target, { CORE_API_URL: 'http://x' });
    const stat = fs.statSync(target);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(target, 'utf8'), 'CORE_API_URL="http://x"\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('persistDotenvFile preserves and updates existing content', async () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, '.env');
    fs.writeFileSync(target, 'FOO=bar\nCORE_API_URL="http://old"\n');
    await persistDotenvFile(target, { CORE_API_URL: 'http://new' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'FOO=bar\nCORE_API_URL="http://new"\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('persistDotenvFile rejects invalid values before touching the filesystem', async () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, '.env');
    await assert.rejects(persistDotenvFile(target, { CORE_SIGNING_SECRET: 'bad\nvalue' }), DotenvValueError);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('persistDotenvFile writes through a same-directory temp file and renames into place', async (t) => {
  const dir = tempDir();
  try {
    const target = path.join(dir, '.env');
    const seenTempPaths: string[] = [];
    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    t.mock.method(fs.promises, 'writeFile', async (file: fs.PathLike, data: string, options?: fs.WriteFileOptions) => {
      seenTempPaths.push(String(file));
      return originalWriteFile(file, data, options);
    });

    await persistDotenvFile(target, { CORE_API_URL: 'http://x' });

    assert.equal(seenTempPaths.length, 1);
    const tempPath = seenTempPaths[0]!;
    assert.equal(path.dirname(tempPath), dir);
    assert.notEqual(tempPath, target);
    assert.ok(!fs.existsSync(tempPath), 'temp file should have been renamed into place');
    assert.ok(fs.existsSync(target));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('persistDotenvFile cleans up the temp file when the rename fails', async (t) => {
  const dir = tempDir();
  try {
    const target = path.join(dir, '.env');

    t.mock.method(fs.promises, 'rename', async () => {
      throw new Error('simulated rename failure');
    });

    await assert.rejects(persistDotenvFile(target, { CORE_API_URL: 'http://x' }), /simulated rename failure/);

    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('persistDotenvFile refuses to read through a symbolic-link target', async () => {
  const dir = tempDir();
  try {
    const source = path.join(dir, 'private-source');
    const target = path.join(dir, '.env');
    fs.writeFileSync(source, 'PRIVATE_SOURCE_VALUE=must-not-copy\n');
    fs.symlinkSync(source, target);

    await assert.rejects(persistDotenvFile(target, { CORE_API_URL: 'http://x' }), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'ELOOP');
      return true;
    });
    assert.equal(fs.readFileSync(source, 'utf8'), 'PRIVATE_SOURCE_VALUE=must-not-copy\n');
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

