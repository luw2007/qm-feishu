import type { FeishuSurfaceConfig } from './config.js';
import { resolveConfig } from './config.js';

export interface FeishuSurfaceHandle {
  stop(): Promise<void>;
}

export function startFeishuSurface(config: FeishuSurfaceConfig): Promise<FeishuSurfaceHandle> {
  return Promise.resolve().then(() => {
    resolveConfig(config);
    throw new Error('Runtime adapters are not composed');
  });
}
