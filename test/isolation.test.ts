import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import * as publicApi from '../src/index.ts';

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(resolved) : [resolved];
  }));
  return nested.flat();
}

test('exports one runtime entrypoint and public types only', () => {
  assert.deepEqual(Object.keys(publicApi), ['startFeishuSurface']);
});

test('contains no QM source dependency or checkout reference', async () => {
  const manifest = await readFile('package.json', 'utf8');
  const sourceFiles = await filesUnder('src');
  const contents = await Promise.all(sourceFiles.map((file) => readFile(file, 'utf8')));
  const combined = `${manifest}\n${contents.join('\n')}`;

  assert.doesNotMatch(combined, /@yc-software\/qm|plugins\/chassis|(?:\.\.\/)+qm\/|~\/ai\/qm|github\.com\/(?:yc-software\/)?qm/);
  const pkg = JSON.parse(manifest) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  for (const spec of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.doesNotMatch(spec, /^(?:file:|link:)|(?:^|[/@])qm(?:\.git)?(?:#|$)/);
  }
});

test('fixtures contain synthetic Feishu identifiers only', async () => {
  const fixtures = await filesUnder('test/fixtures').catch(() => []);
  for (const fixture of fixtures) {
    const content = await readFile(fixture, 'utf8');
    const ids = content.match(/\b(?:ou|oc|om)_[A-Za-z0-9_-]+\b/g) ?? [];
    assert.ok(ids.every((id) => /^(?:ou|oc|om)_test_/.test(id)), `${fixture} contains a non-synthetic identifier`);
  }
});
