import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogEvent = Record<string, unknown>;
export type Logger = (event: LogEvent) => void;

export type LoggerOptions = {
  level?: LogLevel;
  correlationId?: string;
  sink?: (line: string) => void;
  now?: () => number;
};

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const REDACTED_KEYS = new Set([
  'text',
  'displayText',
  'content',
  'command',
  'action',
  'coreSigningSecret',
  'feishuAppSecret',
  'signingSecret',
  'appSecret',
  'token',
  'accessToken',
  'password',
]);

const REDACTED_PLACEHOLDER = '[redacted]';

function isLogLevel(value: unknown): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(key) ? REDACTED_PLACEHOLDER : redact(nested);
    }
    return out;
  }
  return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_RANK[options.level ?? 'info'];
  const correlationId = options.correlationId ?? randomUUID();
  const sink =
    options.sink ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const now = options.now ?? Date.now;

  return (event: LogEvent) => {
    const severity = isLogLevel(event.level) ? event.level : 'info';
    if (LEVEL_RANK[severity] < threshold) return;
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      if (key === 'level') continue;
      rest[key] = REDACTED_KEYS.has(key) ? REDACTED_PLACEHOLDER : redact(value);
    }
    sink(JSON.stringify({ ts: now(), correlationId, level: severity, ...rest }));
  };
}
