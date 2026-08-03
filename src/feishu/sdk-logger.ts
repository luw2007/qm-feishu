export type FeishuSdkLogger = {
  error(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  info(...values: unknown[]): void;
  debug(...values: unknown[]): void;
  trace(...values: unknown[]): void;
};

const ignore = (): void => undefined;

export const silentFeishuSdkLogger: FeishuSdkLogger = {
  error: ignore,
  warn: ignore,
  info: ignore,
  debug: ignore,
  trace: ignore,
};
