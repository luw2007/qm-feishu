import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const fsp = fs.promises;

export const MANAGED_KEYS = [
  'CORE_API_URL',
  'CORE_SIGNING_SECRET',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_BOT_OPEN_ID',
  'FEISHU_TENANT_KEY',
  'FEISHU_BRAND',
] as const;

export type ManagedKey = (typeof MANAGED_KEYS)[number];

export interface DotenvLine {
  readonly raw: string;
  readonly key?: string;
}

export class DotenvValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DotenvValueError';
  }
}

const KEY_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export function parseDotenvLines(content: string): DotenvLine[] {
  if (content.length === 0) return [];
  const rawLines = content.split('\n');
  if (rawLines[rawLines.length - 1] === '') rawLines.pop();
  return rawLines.map((raw) => {
    const key = KEY_PATTERN.exec(raw)?.[1];
    return key === undefined ? { raw } : { raw, key };
  });
}

export function renderDotenvLines(lines: readonly DotenvLine[]): string {
  if (lines.length === 0) return '';
  return lines.map((line) => line.raw).join('\n') + '\n';
}

export function quoteDotenvValue(value: string): string {
  if (/[\n\r\0]/.test(value)) throw new DotenvValueError('dotenv value must not contain newline or NUL characters');
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function formatEntry(key: ManagedKey, value: string): string {
  return `${key}=${quoteDotenvValue(value)}`;
}

export function updateDotenvLines(lines: readonly DotenvLine[], updates: Partial<Record<ManagedKey, string>>): DotenvLine[] {
  const applied = new Set<string>();
  const out: DotenvLine[] = [];

  for (const line of lines) {
    if (line.key !== undefined) {
      const key = line.key as ManagedKey;
      const value = updates[key];
      if (value !== undefined) {
        if (applied.has(key)) continue;
        applied.add(key);
        out.push({ raw: formatEntry(key, value), key });
        continue;
      }
    }
    out.push(line);
  }

  for (const key of MANAGED_KEYS) {
    const value = updates[key];
    if (value !== undefined && !applied.has(key)) {
      out.push({ raw: formatEntry(key, value), key });
    }
  }

  return out;
}

export function updateDotenvContent(content: string, updates: Partial<Record<ManagedKey, string>>): string {
  return renderDotenvLines(updateDotenvLines(parseDotenvLines(content), updates));
}

export async function persistDotenvFile(filePath: string, updates: Partial<Record<ManagedKey, string>>): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });

  let existing = '';
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    existing = await handle.readFile('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    await handle?.close();
  }

  const content = updateDotenvContent(existing, updates);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);

  try {
    await fsp.writeFile(tempPath, content, { mode: 0o600 });
    await fsp.chmod(tempPath, 0o600);
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true });
    throw error;
  }
}
